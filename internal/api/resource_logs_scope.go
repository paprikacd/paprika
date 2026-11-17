package apiserver

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"connectrpc.com/connect"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const (
	// logsTreeMaxOwnerHops is a guard on the owner-chain walk. childDiscovery
	// adds at most two levels between a managed root and a Pod (Deployment to
	// ReplicaSet to Pod), so a real chain never reaches it.
	logsTreeMaxOwnerHops = 4
	// logsTreeMaxOwnerRefs bounds how many parent-kind owner references one object
	// is checked against. Kubernetes objects have one controller in practice; an
	// object past the bound is outside the tree for this request.
	logsTreeMaxOwnerRefs = 8
	// logsTreeMaxReads bounds the owner-object GETs one request may spend. When
	// the budget runs out, the walk answers "outside the tree".
	logsTreeMaxReads = 16
	// logsWorkloadPodLimit bounds how many pods a workload's selector is listed
	// for. Pods past the first page are not considered.
	logsWorkloadPodLimit = 50
)

// errLogsReadBudget reports that a request spent its owner-object reads.
var errLogsReadBudget = errors.New("owner read budget exhausted")

// errLogsReadFailed is the only read-failure text a caller sees. The API error
// behind it is logged on the server, so responses carry no cluster detail.
var errLogsReadFailed = errors.New("could not read the resource from its cluster; see the server logs")

// childParentKinds inverts childDiscovery: for a kind, the parent kinds whose
// children the resource tree discovers. The walk and the tree share one map.
var childParentKinds = invertChildDiscovery()

func invertChildDiscovery() map[string][]string {
	parents := make(map[string][]string)
	for parent, children := range childDiscovery {
		for _, child := range children {
			parents[child] = append(parents[child], parent)
		}
	}
	for child := range parents {
		slices.Sort(parents[child])
	}
	return parents
}

// logsTreeScope answers whether a resource is in one application's resource
// tree. It follows the same rules as GetResourceTree: managed resources are
// roots, and a child is in the tree when an owner reference names a parent kind
// from childDiscovery whose instance is in the tree.
//
// A scope serves one request. It memoizes owner reads and counts them, so a
// workload with many candidate pods reads each shared ReplicaSet once.
type logsTreeScope struct {
	app   *pipelinesv1alpha1.Application
	typed kubernetes.Interface
	// reads counts the owner-object GETs this request has spent.
	reads int
	// owners holds the owner references of each object already read, keyed by
	// kind, namespace and name. A missing or unreadable object holds none.
	owners map[string][]metav1.OwnerReference
}

func newLogsTreeScope(app *pipelinesv1alpha1.Application, typed kubernetes.Interface) *logsTreeScope {
	return &logsTreeScope{app: app, typed: typed, owners: make(map[string][]metav1.OwnerReference)}
}

// resolveApplicationLogsPod returns the single pod a log request for kind/name
// in namespace may read. The pod must be one the application's resource tree
// shows: a managed pod, or a pod reached from a managed resource through the
// owner references the tree follows. Every other resource, existing or not,
// gets the same CodeNotFound error.
//
// typed must be the application's destination cluster client. Logs from the
// control plane's own cluster answer for the wrong workload when names match.
//
// Errors are *connect.Error for the outside-the-tree case (CodeNotFound) and
// for a request the server cannot accept (CodeInvalidArgument), and for a
// caller that went away (CodeCanceled, or CodeDeadlineExceeded when its
// deadline passed). Other failures are plain errors whose text is
// safe to show the caller. A managed resource that is gone keeps its own
// message.
func resolveApplicationLogsPod(
	ctx context.Context,
	typed kubernetes.Interface,
	app *pipelinesv1alpha1.Application,
	kind, name, namespace string,
) (*corev1.Pod, error) {
	switch kind {
	case "Pod", "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job":
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("logs only available for Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, or Job"))
	}
	if err := validateLogsIdentifiers(name, namespace); err != nil {
		return nil, err
	}
	sc := newLogsTreeScope(app, typed)
	// Every tree node lives in the namespace of a managed root, because owner
	// references stay in one namespace. A request for any other namespace is
	// outside the tree, so it is answered before any read.
	if !sc.inApplicationNamespace(namespace) {
		return nil, logsOutsideApplicationError(kind, namespace, name)
	}
	if kind == "Pod" {
		return sc.resolvePod(ctx, name, namespace)
	}
	return sc.resolveWorkloadPod(ctx, kind, name, namespace)
}

// usableOwnerName reports whether an owner reference's name passes DNS-1123
// subdomain validation. No ReplicaSet or Job can have a name that fails it, and
// client-go refuses some such names before sending a request. An owner that
// fails is treated as absent, without a read, and is not counted toward
// logsTreeMaxOwnerRefs.
func usableOwnerName(name string) bool {
	return name != "" && len(validation.IsDNS1123Subdomain(name)) == 0
}

// validateLogsIdentifiers rejects a name or namespace the cluster could never
// hold, before any read. The error names the bad value, which the caller sent.
func validateLogsIdentifiers(name, namespace string) error {
	if errs := validation.IsDNS1123Subdomain(name); len(errs) > 0 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid resource name %q", name))
	}
	return validateLogsNamespace(namespace)
}

// validateLogsNamespace rejects a namespace the cluster could never hold.
func validateLogsNamespace(namespace string) error {
	if errs := validation.IsDNS1123Label(namespace); len(errs) > 0 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid resource namespace %q", namespace))
	}
	return nil
}

// resolvePod reads a pod the request names and checks it is in the tree.
func (sc *logsTreeScope) resolvePod(ctx context.Context, name, namespace string) (*corev1.Pod, error) {
	pod, err := sc.typed.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, sc.resourceReadError(ctx, "Pod", namespace, name, err)
	}
	if err = sc.requireInTree(ctx, "Pod", namespace, name, pod.OwnerReferences); err != nil {
		return nil, err
	}
	return pod, nil
}

// resourceReadError maps a failed read of the resource a request names. A
// managed resource that is gone keeps its own message, since the tree shows it.
// A managed resource the credential cannot read is a failed read, logged for the
// operator, since the tree shows it too. A missing or forbidden resource that
// the tree does not show gets the outside-the-tree answer. Anything else is
// logged and reported generically.
func (sc *logsTreeScope) resourceReadError(ctx context.Context, kind, namespace, name string, err error) error {
	switch {
	case sc.managed(kind, namespace, name) && apierrors.IsNotFound(err):
		return fmt.Errorf("%s %s/%s not found", kind, namespace, name)
	case sc.managed(kind, namespace, name) && apierrors.IsForbidden(err):
		return logsReadFailure(ctx, kind, namespace, name, err)
	case apierrors.IsNotFound(err), apierrors.IsForbidden(err):
		return logsOutsideApplicationError(kind, namespace, name)
	default:
		return logsReadFailure(ctx, kind, namespace, name, err)
	}
}

// inApplicationNamespace reports whether a managed resource lives in namespace.
// A managed resource with no namespace in status belongs to the application's
// namespace, as it does in managed.
func (sc *logsTreeScope) inApplicationNamespace(namespace string) bool {
	for _, r := range sc.app.Status.Resources {
		ns := r.Namespace
		if ns == "" {
			ns = sc.app.Namespace
		}
		if ns == namespace {
			return true
		}
	}
	return false
}

// resolveWorkloadPod checks a workload is in the tree, then returns the first
// pod its selector matches that the workload owns. A selector can match pods of
// other owners, in or out of the tree, so each candidate must pass through the
// requested workload. Candidates of other owners cost no read.
func (sc *logsTreeScope) resolveWorkloadPod(ctx context.Context, kind, name, namespace string) (*corev1.Pod, error) {
	spec, err := readWorkloadSpec(ctx, sc.typed, kind, name, namespace)
	if err != nil {
		return nil, sc.resourceReadError(ctx, kind, namespace, name, err)
	}
	sc.remember(kind, namespace, name, spec.owners)
	if err = sc.requireInTree(ctx, kind, namespace, name, spec.owners); err != nil {
		return nil, err
	}
	pods, err := listWorkloadPods(ctx, sc.typed, spec.selector, kind, name, namespace)
	if err != nil {
		return nil, err
	}
	for i := range pods {
		var owned bool
		owned, err = sc.ownedByWorkload(ctx, kind, name, namespace, pods[i].OwnerReferences)
		if err != nil {
			return nil, err
		}
		if !owned {
			continue
		}
		var ok bool
		ok, err = sc.contains(ctx, "Pod", namespace, pods[i].Name, pods[i].OwnerReferences, 0)
		if err != nil {
			return nil, err
		}
		// The contains check is defence in depth. Ownership above already places
		// the pod under the requested workload, and no test fails when this
		// check is removed, so it is not independently pinned.
		if ok {
			return &pods[i], nil
		}
	}
	// Matches outside the tree get the same answer as no match, so a caller
	// cannot tell a foreign pod from an absent one.
	return nil, fmt.Errorf("no pods found for %s/%s", kind, name)
}

// ownedByWorkload reports whether a pod's owner references lead to the workload
// the request names. The pod's owner is the workload for StatefulSet, DaemonSet,
// Job and ReplicaSet. A Deployment owns pods through its ReplicaSets, so the
// owner is a ReplicaSet whose own owner is the Deployment. Owners of any other
// kind are skipped without a read.
func (sc *logsTreeScope) ownedByWorkload(
	ctx context.Context,
	kind, name, namespace string,
	owners []metav1.OwnerReference,
) (bool, error) {
	if kind == "Deployment" {
		return sc.ownedThroughReplicaSets(ctx, name, namespace, owners)
	}
	return slices.ContainsFunc(owners, func(o metav1.OwnerReference) bool {
		return o.Name != "" && o.Kind == kind && o.Name == name
	}), nil
}

// ownedThroughReplicaSets reports whether one of a pod's ReplicaSet owners is
// owned by the named Deployment. At most logsTreeMaxOwnerRefs ReplicaSets are read.
func (sc *logsTreeScope) ownedThroughReplicaSets(
	ctx context.Context,
	deployment, namespace string,
	owners []metav1.OwnerReference,
) (bool, error) {
	examined := 0
	for i := range owners {
		owner := &owners[i]
		if owner.Kind != "ReplicaSet" || !usableOwnerName(owner.Name) {
			continue
		}
		if examined == logsTreeMaxOwnerRefs {
			break
		}
		examined++
		replicaSetOwners, err := sc.ownerRefsOf(ctx, "ReplicaSet", namespace, owner.Name)
		if errors.Is(err, errLogsReadBudget) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if slices.ContainsFunc(replicaSetOwners, func(o metav1.OwnerReference) bool {
			return o.Kind == "Deployment" && o.Name == deployment
		}) {
			return true, nil
		}
	}
	return false, nil
}

// requireInTree returns the outside-the-tree error unless the object is in the
// tree. owners are the object's owner references.
func (sc *logsTreeScope) requireInTree(ctx context.Context, kind, namespace, name string, owners []metav1.OwnerReference) error {
	ok, err := sc.contains(ctx, kind, namespace, name, owners, 0)
	if err != nil {
		return err
	}
	if !ok {
		return logsOutsideApplicationError(kind, namespace, name)
	}
	return nil
}

// logsOutsideApplicationError is the one error for a resource the application's
// tree does not hold. The text names only what the caller asked for, so a
// missing resource and an existing unrelated one cannot be told apart.
func logsOutsideApplicationError(kind, namespace, name string) error {
	return connect.NewError(connect.CodeNotFound,
		fmt.Errorf("%s %s/%s was not found in this application's resource tree", kind, namespace, name))
}

// logsReadFailure logs a read error the caller must not see and returns the
// generic error in its place. A read that failed because the caller went away
// is not a server fault: it logs nothing and returns CodeCanceled, or
// CodeDeadlineExceeded when the caller's deadline passed.
func logsReadFailure(ctx context.Context, kind, namespace, name string, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		if errors.Is(ctxErr, context.DeadlineExceeded) {
			return connect.NewError(connect.CodeDeadlineExceeded, ctxErr)
		}
		return connect.NewError(connect.CodeCanceled, ctxErr)
	}
	log.FromContext(ctx).Error(err, "reading a resource failed", "kind", kind, "namespace", namespace, "name", name)
	return errLogsReadFailed
}

// managed reports whether the application lists the resource as a root. A
// resource with no namespace in status belongs to the application's namespace,
// as it does in the tree.
func (sc *logsTreeScope) managed(kind, namespace, name string) bool {
	for _, r := range sc.app.Status.Resources {
		ns := r.Namespace
		if ns == "" {
			ns = sc.app.Namespace
		}
		if r.Kind == kind && r.Name == name && ns == namespace {
			return true
		}
	}
	return false
}

// contains reports whether the object is in the tree. owners are the object's
// owner references. hops counts the owner steps already taken. A read that the
// budget refuses answers false, so the request is denied rather than failed.
func (sc *logsTreeScope) contains(
	ctx context.Context,
	kind, namespace, name string,
	owners []metav1.OwnerReference,
	hops int,
) (bool, error) {
	if sc.managed(kind, namespace, name) {
		return true, nil
	}
	if hops >= logsTreeMaxOwnerHops {
		return false, nil
	}
	parentKinds := childParentKinds[kind]
	examined := 0
	for i := range owners {
		owner := &owners[i]
		if !usableOwnerName(owner.Name) || !slices.Contains(parentKinds, owner.Kind) {
			continue
		}
		if examined == logsTreeMaxOwnerRefs {
			break
		}
		examined++
		ok, err := sc.ownerInTree(ctx, namespace, owner, hops)
		if err != nil || ok {
			return ok, err
		}
	}
	return false, nil
}

// ownerInTree reports whether an owner reference names an object in the tree.
// Owners are resolved in the object's namespace, as owner references are.
func (sc *logsTreeScope) ownerInTree(ctx context.Context, namespace string, owner *metav1.OwnerReference, hops int) (bool, error) {
	if sc.managed(owner.Kind, namespace, owner.Name) {
		return true, nil
	}
	parentOwners, err := sc.ownerRefsOf(ctx, owner.Kind, namespace, owner.Name)
	if errors.Is(err, errLogsReadBudget) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return sc.contains(ctx, owner.Kind, namespace, owner.Name, parentOwners, hops+1)
}

// ownerRefsOf returns the owner references of an owner object. Only
// ReplicaSets and Jobs can have a parent in childDiscovery, so other kinds are
// never read. A missing or forbidden object has none, so it is outside the tree.
func (sc *logsTreeScope) ownerRefsOf(ctx context.Context, kind, namespace, name string) ([]metav1.OwnerReference, error) {
	if kind != "ReplicaSet" && kind != "Job" {
		return nil, nil
	}
	// Defence in depth: both callers check the owner name before they get here,
	// so this guard is not reached today. It keeps an invalid name from ever
	// reaching the cluster client, which refuses some such names.
	if !usableOwnerName(name) {
		return nil, nil
	}
	if owners, ok := sc.owners[ownerKey(kind, namespace, name)]; ok {
		return owners, nil
	}
	if sc.reads >= logsTreeMaxReads {
		return nil, errLogsReadBudget
	}
	sc.reads++
	spec, err := sc.readOwnerSpec(ctx, kind, namespace, name)
	if err != nil {
		return nil, err
	}
	sc.remember(kind, namespace, name, spec.owners)
	return spec.owners, nil
}

// readOwnerSpec reads an owner object for the walk. A missing or forbidden owner
// has no owners, so the object it would place is outside the tree. Without a
// destination client nothing can be read, so the owner is outside the tree too.
func (sc *logsTreeScope) readOwnerSpec(ctx context.Context, kind, namespace, name string) (workloadSpec, error) {
	if sc.typed == nil {
		return workloadSpec{}, nil
	}
	spec, err := readWorkloadSpec(ctx, sc.typed, kind, name, namespace)
	switch {
	case err == nil:
		return spec, nil
	case apierrors.IsNotFound(err):
		return workloadSpec{}, nil
	case apierrors.IsForbidden(err):
		// Logged at verbosity 1, so an operator whose credential cannot read owners can find the cause.
		log.FromContext(ctx).V(1).Info("owner read forbidden; object treated as outside the tree",
			"kind", kind, "namespace", namespace, "name", name)
		return workloadSpec{}, nil
	default:
		return workloadSpec{}, logsReadFailure(ctx, kind, namespace, name, err)
	}
}

// remember stores the owner references of a ReplicaSet or Job so a later walk
// does not read it again. Other kinds are never walked, so they are not kept.
func (sc *logsTreeScope) remember(kind, namespace, name string, owners []metav1.OwnerReference) {
	if kind != "ReplicaSet" && kind != "Job" {
		return
	}
	sc.owners[ownerKey(kind, namespace, name)] = owners
}

func ownerKey(kind, namespace, name string) string {
	return kind + "/" + namespace + "/" + name
}

// workloadSpec is what the log scope reads from a workload: the owner
// references that place it in the tree, and the selector that picks its pods.
type workloadSpec struct {
	owners   []metav1.OwnerReference
	selector *metav1.LabelSelector
}

// readWorkloadSpec reads one workload. A missing workload's error stays an
// API NotFound, so a caller can check it with apierrors.IsNotFound.
func readWorkloadSpec(ctx context.Context, typed kubernetes.Interface, kind, name, namespace string) (workloadSpec, error) {
	read, ok := workloadReaders(typed, namespace)[kind]
	if !ok {
		return workloadSpec{}, fmt.Errorf("unsupported workload kind %q", kind)
	}
	return read(ctx, name)
}

// workloadReaders maps each workload kind to a read of one workload in namespace.
func workloadReaders(typed kubernetes.Interface, namespace string) map[string]func(context.Context, string) (workloadSpec, error) {
	return map[string]func(context.Context, string) (workloadSpec, error){
		"Deployment": func(ctx context.Context, name string) (workloadSpec, error) {
			obj, err := typed.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				return workloadSpec{}, fmt.Errorf("get deployment: %w", err)
			}
			return workloadSpec{owners: obj.OwnerReferences, selector: obj.Spec.Selector}, nil
		},
		"ReplicaSet": func(ctx context.Context, name string) (workloadSpec, error) {
			obj, err := typed.AppsV1().ReplicaSets(namespace).Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				return workloadSpec{}, fmt.Errorf("get replicaset: %w", err)
			}
			return workloadSpec{owners: obj.OwnerReferences, selector: obj.Spec.Selector}, nil
		},
		"StatefulSet": func(ctx context.Context, name string) (workloadSpec, error) {
			obj, err := typed.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				return workloadSpec{}, fmt.Errorf("get statefulset: %w", err)
			}
			return workloadSpec{owners: obj.OwnerReferences, selector: obj.Spec.Selector}, nil
		},
		"DaemonSet": func(ctx context.Context, name string) (workloadSpec, error) {
			obj, err := typed.AppsV1().DaemonSets(namespace).Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				return workloadSpec{}, fmt.Errorf("get daemonset: %w", err)
			}
			return workloadSpec{owners: obj.OwnerReferences, selector: obj.Spec.Selector}, nil
		},
		"Job": func(ctx context.Context, name string) (workloadSpec, error) {
			obj, err := typed.BatchV1().Jobs(namespace).Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				return workloadSpec{}, fmt.Errorf("get job: %w", err)
			}
			return workloadSpec{owners: obj.OwnerReferences, selector: obj.Spec.Selector}, nil
		},
	}
}

// listWorkloadPods returns up to logsWorkloadPodLimit pods that the workload's
// selector matches. A workload without a selector lists nothing.
func listWorkloadPods(
	ctx context.Context,
	typed kubernetes.Interface,
	selector *metav1.LabelSelector,
	kind, name, namespace string,
) ([]corev1.Pod, error) {
	labels, err := logsPodSelectorString(selector, kind, name)
	if err != nil {
		return nil, err
	}
	list, err := typed.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labels,
		Limit:         logsWorkloadPodLimit,
	})
	if err != nil {
		return nil, logsReadFailure(ctx, kind, namespace, name, err)
	}
	return list.Items, nil
}
