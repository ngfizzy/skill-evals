# Provenance and licensing

This package is a TypeScript extraction of its owner's existing Ruby behavioral skill-evaluation
runner. The owner authorized the extraction. The CLI, catalog, process adapter, grading and report
contracts derive from that runner. The extraction baseline used `response-decisions-v2`. The
preserved Ruby source uses `response-decisions-v3`: the judge selects response segment IDs and the
runner retrieves evidence text. This Bun CLI uses `response-decisions-v4`, adding the same skill
bundle as grader reference context. These are intentional grading-contract changes; v2 reports
remain historical artifacts and are not silently converted. Legacy rubric semantics are preserved.
The Ruby consumer runner remains in place; moving consumers to this package requires an explicit
migration decision.

No private skill instructions, real workflow cases, career data, credentials or private evaluation
reports belong in this repository or npm tarball. Included examples and automated test fixtures are
synthetic. Source locations and release planning remain in private operational records outside this
package.

The original runner did not carry a repository-wide license at extraction time. Extraction
authorization does not establish a public license grant. This release candidate is **UNLICENSED**
and `private: true` prevents accidental npm publishing. Before public release, the owner must
resolve source rights, choose a license, review dependency notices and approve publication. The
package name is provisional; a registry 404 is not a reservation or proof of publishing rights.

The runtime dependency is `yaml` (ISC); development dependencies and licenses are recorded in the
lockfile and must be reviewed for the final release. No third-party Codex binary is bundled; users
install and authenticate Codex separately.
