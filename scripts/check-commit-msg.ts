// Enforces the commit labels from AGENTS.md (IMP rule 9):
// `fix:` only for defects in live code, everything else `feat:` or `refine:`.
import { readFileSync } from "node:fs";

const LABEL = /^(feat|fix|refine)(\([a-z0-9-]+\))?!?: \S/;
// Messages git writes itself.
const GENERATED = /^(Merge|Revert|fixup!|squash!) /;

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write("check-commit-msg: missing path to the commit message file\n");
  process.exit(2);
}

const subject = readFileSync(path, "utf8").split("\n")[0] ?? "";
if (!LABEL.test(subject) && !GENERATED.test(subject)) {
  process.stderr.write(
    `Commit subject must start with feat:, fix: or refine: (see AGENTS.md, Labels).\nGot: "${subject}"\n`,
  );
  process.exit(1);
}
