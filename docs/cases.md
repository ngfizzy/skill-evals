# Case formats

Roots contain `skills/NAME/SKILL.md`. Skill directory names are the discovery identity. Skills
without cases can supply dependencies. Duplicate skill names across roots are errors. Both formats
in one skill are ambiguous and rejected.

## YAML

```yaml
skill: routing
requires: [shared-review]
behaviors:
  - name: Route a small change
    given: A README typo changes. Choose the review route.
    must:
      - Selects Routine review.
    must_not:
      - Claims a real review was completed.
```

Cases use `NAME/behavior-1`, `NAME/behavior-2`, and so on in declared order. `must` and `must_not`
are arrays of nonempty strings. `must` is required but may be empty when there is at least one
`must_not` criterion. Each case needs at least one criterion. `name` and `given` must be nonempty
strings.

`required=true` criteria pass when demonstrated. `required=false` criteria pass when prohibited
behavior is absent. A prohibition phrased inside `must` keeps its positive polarity and needs
relevant evidence segments for a passing verdict. YAML duplicate keys, aliases and custom tags are
rejected.

## JSON

```json
{
  "skill_name": "routing",
  "evals": [
    {
      "id": "small",
      "prompt": "A README typo changes. Choose the review route.",
      "expected_output": "Selects Routine review.",
      "assertions": ["Keeps the review bounded to the changed text."]
    }
  ]
}
```

`skill_name` is optional; when present it must match the directory name. IDs, prompts, expected
output and assertion text must be nonempty strings. Every `expected_output` becomes a required
criterion alongside the optional assertions. Case keys are `NAME/id`; duplicate keys are rejected.
Assertion IDs are assigned as `assertion-1`, `assertion-2`, and so on, starting with the expected
output.

## Dependencies and bounds

Declare dependencies in YAML `requires`, or at the root in `external-skills.yaml` for either case
format:

```yaml
references:
  routing: [shared-review]
```

Dependencies resolve by name across all roots. Bundles visit dependencies before the selected skill,
deduplicating repeated/cyclic references. A missing dependency errors before model calls. All
Markdown files under a skill's `references/` tree are included in sorted order; eval metadata is
excluded. Entrypoints and reference files receive stable `--- NAME/path ---` section labels.

Paths resolve through real paths and must stay inside their owning root, skills directory or skill
as appropriate. Symlinks to outside locations and cyclic reference directories are rejected. Files
must be regular UTF-8 files. Case and manifest sources are bounded to 2 MiB each; complete
instruction bundles to 512 KiB. Catalogs and reference traversals have a 10,000-entry bound.

## Explicit rubrics and focused context

JSON cases may use `criteria: {"must": ["Chooses Routine"], "must_not": []}` instead of legacy
`expected_output` and `assertions`. Mixing the two formats is an error; existing rubrics keep their
semantics. At least one criterion is required.

Either case format accepts `references: ["references/routes.md"]` per case. `--context focused` uses
exactly those paths with the skill entrypoint; an empty array includes only the entrypoint. An
absent declaration uses full context and is reported as `full-fallback`. Dependencies still load in
full. `--context full` (the default) includes all references. Paths must be Markdown files under
`references/`, without traversal components, and stay within the owning skill after resolving
symlinks. Keep case reference declarations relevant and include prerequisites needed to make the
tested decision. The runner does not infer them or recursively follow Markdown links.

Declared reference paths are validated when loading the catalog, including for `--list` and
full-context runs: each must exist, resolve inside the skill, and be a regular file. Each case is
limited to 128 criteria. Candidate responses are limited to 2,048 evidence segments; exceeding that
limit is an unscored error, never silent truncation. Evidence IDs are checked against the original
response after grading; schemas do not repeat the response-ID list per criterion.
