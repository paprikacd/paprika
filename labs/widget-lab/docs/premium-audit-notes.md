# Frontend Design Premium static audit

Auditor: installed Frontend Design Premium 1.4.0 `scripts/audit_project.py`.

The audit configuration is `docs/premium-audit.config.json`. It uses the product-admin profile, the maintained root UX contract, and the complete `src` directory, including the unchanged Paprika vendor copy. No source exclusions, rule suppressions or waivers were added. The required canonical capabilities are the authored Select/Listbox and application Scrollbar; this evaluation has no CRUD, date picker, form submission, bulk table selection or toast workflow. The configured test/typecheck/build commands are real package scripts; the static audit does not execute them.

## Command and result

```sh
python3 /root/.codex/plugins/cache/openai-curated-remote/frontend-design-premium/1.4.0/skills/frontend-design-premium/scripts/audit_project.py /workspace/scratch/ffa6c3757aaa/paprika-widget-lab --mode strict --config /workspace/scratch/ffa6c3757aaa/paprika-widget-lab/docs/premium-audit.config.json --output /workspace/scratch/ffa6c3757aaa/paprika-widget-lab/docs/premium-audit.json
```

Exit code: **1**. The unmodified JSON report records one error, one violation, zero warnings and zero unresolved ownership findings.

## Owned source finding fixed

The initial run reported `scrollbar.webkit-only` in `src/styles.css`. The application scope declared `scrollbar-color` while its descendants declared both standards properties. Added `scrollbar-width: thin` to `.lab-app`, making the standard property pair explicit on both the scope and its descendants. Existing WebKit fallbacks, theme variables and forced-colors behavior remain intact. The final strict run no longer reports this finding.

## Residual vendored source finding

`form.textarea-resize-missing` is reported at `src/vendor/paprika/ui/src/features/insights/gamma/input.tsx:37`.

The source uses the canonical CSS Module classes `styles.input` and `styles.textarea`. In the imported `gamma/controls.module.css`, `.input.textarea.textarea` explicitly declares `resize: none`, `field-sizing: content`, `max-height: 60dvh` and `overflow: auto`. The auditor checks only literal textarea attributes for `resize-none` or inline `resize: none`; it does not resolve CSS Module selectors. This finding is therefore a documented source-scan limitation, supported by the imported stylesheet. The lab does not render GammaTextarea.

The vendor copy and auditor were not edited to remove the finding. The raw audit remains a nonzero strict result; it must not be described as a clean strict pass. No findings remain in owned lab source under this static audit.

## Verification boundary

The maintained DESIGN and UX contracts were read, and no native dialog or `reportValidity` call was found in owned App/components/data/format/main sources. Browser checks, actual scrollbar computed styles, keyboard behavior, contrast, numerical tests and production build are separate evidence owned by the main evaluation workflow. This audit does not establish those results.
