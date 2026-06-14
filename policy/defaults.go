package policy

import policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"

func defaultAction(sev policyv1alpha1.PolicySeverity) policyv1alpha1.PolicyAction {
	if sev == policyv1alpha1.PolicySeverityWarning {
		return policyv1alpha1.PolicyActionWarn
	}
	return policyv1alpha1.PolicyActionEnforce
}
