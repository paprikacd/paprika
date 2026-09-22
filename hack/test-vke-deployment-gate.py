#!/usr/bin/env python3
"""Exercise the checked-in VKE job condition without GitHub or cluster access."""

import ast
from itertools import product
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent.parent


def job_condition(workflow, job):
    text = (ROOT / ".github/workflows" / workflow).read_text()
    block = re.search(rf"^  {re.escape(job)}:\n(.*?)(?=^  \S|\Z)", text, re.M | re.S)
    assert block, f"missing {workflow} job {job}"
    conditions = re.findall(r"^    if: (.+)$", block[1], re.M)
    assert len(conditions) == 1, f"expected one inline {job} condition"
    return conditions[0]


def evaluate(condition, event, ref, enabled):
    # This condition uses only string equality and boolean operators. Interpret
    # that subset instead of eval(), rejecting newly introduced expression forms.
    translated = condition.replace("&&", " and ").replace("||", " or ")
    contexts = {"github.event_name": event, "github.ref": ref,
                "vars.VKE_AUTODEPLOY_ENABLED": enabled}
    expression = ast.parse(translated, mode="eval")

    def visit(node):
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            return contexts[f"{node.value.id}.{node.attr}"]
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.Eq):
            # GitHub Actions ignores case when comparing strings.
            return visit(node.left).lower() == visit(node.comparators[0]).lower()
        if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)):
            values = [visit(value) for value in node.values]
            return all(values) if isinstance(node.op, ast.And) else any(values)
        raise AssertionError(f"unsupported condition node: {type(node).__name__}")

    return visit(expression)


deploy = job_condition("deploy-vke.yml", "deploy")
publish = job_condition("ci.yml", "publish")
events = ["push", "repository_dispatch", "pull_request", "workflow_dispatch"]
refs = ["refs/heads/master", "refs/heads/feature", "refs/tags/v1.0.0"]
settings = ["", "false", "0", "1", "yes", "true", "TRUE", " true "]

for event, ref, enabled in product(events, refs, settings):
    expected = (event in {"push", "repository_dispatch"}
                and ref == "refs/heads/master" and enabled.lower() == "true")
    assert evaluate(deploy, event, ref, enabled) == expected, (
        f"VKE promotion gate mismatch: event={event}, ref={ref}, setting={enabled!r}"
    )
    assert evaluate(publish, event, ref, enabled) == (event == "push" and ref == "refs/heads/master"), (
        "image publication must remain independent of the VKE promotion setting"
    )

for caller in ["ci.yml", "deploy-vke-manual.yml"]:
    text = (ROOT / ".github/workflows" / caller).read_text()
    assert "uses: ./.github/workflows/deploy-vke.yml" in text, f"{caller} bypasses the guarded workflow"

print(f"VKE promotion and image publication conditions passed {len(events) * len(refs) * len(settings)} cases each")
