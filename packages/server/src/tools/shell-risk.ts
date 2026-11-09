// Deterministic rules for the shell's auto mode (C9): a command runs without asking
// unless a rule below finds it destructive, sending data out, or opaque. It reads
// the command line only: what a script does inside (python cleanup.py) is not
// seen. The runner bounds that case: an agent reaches only its own workspace.

/** Why a command needs the user's confirmation; empty when it can run. */
export function risks(command: string): string[] {
  const found = new Set<string>();
  for (const words of simpleCommands(command)) {
    for (const reason of judge(words)) found.add(reason);
  }
  return [...found];
}

const ALWAYS: Record<string, string> = {
  rm: "deletes files",
  rmdir: "deletes directories",
  unlink: "deletes files",
  shred: "destroys files",
  mv: "moves or renames files",
  dd: "writes raw data over files",
  truncate: "empties files",
  chmod: "changes permissions",
  chown: "changes ownership",
  chgrp: "changes ownership",
  kill: "stops processes",
  pkill: "stops processes",
  killall: "stops processes",
  scp: "sends files to another machine",
  sftp: "sends files to another machine",
  rsync: "copies files, possibly to another machine",
  ssh: "runs commands on another machine",
  nc: "opens a raw network connection",
  ncat: "opens a raw network connection",
  netcat: "opens a raw network connection",
  telnet: "opens a raw network connection",
  crontab: "schedules commands",
  eval: "runs code the rules cannot inspect",
  exec: "replaces the shell with another program",
  mkfs: "formats a filesystem",
};

/** Words that run the next word as the command. */
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "nice", "timeout", "xargs", "command"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);
const UPLOAD_FLAGS =
  /^(-d|--data.*|-F|--form.*|-T|--upload-file|-X|--request|--post-.*|--method.*)$/;

function judge(input: string[]): string[] {
  const words = unwrap(input);
  const [name = "", ...args] = words;
  const program = name.split("/").at(-1) ?? name;
  const reasons: string[] = [];
  const always = ALWAYS[program];
  if (always) reasons.push(`${always} (${program})`);

  if (SHELLS.has(program) && args.some((a) => a === "-c" || /^-\w*c$/.test(a))) {
    reasons.push(`runs code the rules cannot inspect (${program} -c)`);
  }
  if (
    program === "find" &&
    args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir")
  ) {
    reasons.push("deletes or runs commands on found files (find)");
  }
  if ((program === "curl" || program === "wget") && args.some((a) => UPLOAD_FLAGS.test(a))) {
    reasons.push(`sends data to another machine (${program})`);
  }
  if (program === "sed" && args.some((a) => /^-\w*i/.test(a) || a.startsWith("--in-place"))) {
    reasons.push("edits files in place (sed -i)");
  }
  if (program === "git") reasons.push(...gitRisks(args));
  if ((program === "pip" || program === "pip3") && args[0] === "uninstall") {
    reasons.push("removes Python packages (pip uninstall)");
  }
  if (program === "python" || program === "python3") {
    if (args[0] === "-m" && (args[1] === "pip" || args[1] === "pip3") && args[2] === "uninstall") {
      reasons.push("removes Python packages (pip uninstall)");
    }
  }
  if (program === "base64" && args.some((a) => a === "-d" || a === "--decode")) {
    reasons.push("decodes hidden content (base64 -d)");
  }
  return reasons;
}

const PUSH = "sends commits to another machine (git push)";

/** The subcommand and what follows it, past git's own options (-C dir, -c key=value). */
function gitCommand(args: string[]): string[] {
  let i = 0;
  while (i < args.length && (args[i] ?? "").startsWith("-")) {
    i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  }
  return args.slice(i);
}

function gitRisks(input: string[]): string[] {
  const args = gitCommand(input);
  const sub = args[0] ?? "";
  if (sub === "push") return [PUSH];
  if (sub === "clean") return ["deletes untracked files (git clean)"];
  if (sub === "rm" || sub === "mv") return [`deletes or moves tracked files (git ${sub})`];
  if (sub === "reset" && args.includes("--hard")) return ["discards changes (git reset --hard)"];
  if ((sub === "checkout" || sub === "restore") && args.some((a) => a === "--" || a === ".")) {
    return [`discards changes (git ${sub})`];
  }
  return [];
}

/** Drops leading VAR=value assignments and wrappers such as sudo or xargs. */
function unwrap(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(word)) {
      i++;
      // Skip the wrapper's own options and arguments (timeout 5, nice -n 10, xargs -0).
      while (i < words.length && /^(-.*|\d+[smhd]?)$/.test(words[i] ?? "")) i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

/**
 * Splits a command line into simple commands (each a list of words), at ; & | &&
 * || newlines, and inside $( ), backticks and ( ). Quotes are honored, so text in
 * an echo is not mistaken for a command. Good enough to find program names; not a
 * full shell parser.
 */
function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  // The word after > or < is where output goes: not an argument.
  let target = false;
  const endWord = () => {
    if (word !== "" && !target) words.push(word);
    if (word !== "") target = false;
    word = "";
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quote) {
      if (c === quote) quote = undefined;
      // A $( ) or backtick inside double quotes still runs.
      else if (quote === '"' && (c === "`" || (c === "$" && line.charAt(i + 1) === "("))) {
        const inner = c === "`" ? closing(line, i + 1, "`") : closing(line, i + 2, ")");
        commands.push(...simpleCommands(line.slice(c === "`" ? i + 1 : i + 2, inner)));
        i = inner;
      } else word += c;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "\\") word += line.charAt(++i);
    else if (c === "#" && word === "") {
      while (i < line.length && line.charAt(i) !== "\n") i++;
      endCommand();
    } else if (c === " " || c === "\t") endWord();
    // "(" also covers $( ): the "$" left behind is not a program name.
    else if (";&|\n()`".includes(c)) endCommand();
    else if (c === ">" || c === "<") {
      // 2>&1, > log, >> log: the descriptor and the target are neither a command nor
      // its arguments.
      if (/^\d+$/.test(word)) word = "";
      endWord();
      if (line.charAt(i + 1) === c) i++;
      if (line.charAt(i + 1) === "&") {
        i++;
        while (/[\d-]/.test(line.charAt(i + 1))) i++;
      } else target = true;
    } else word += c;
  }
  endCommand();
  return commands;
}

/** Index of the closing character, or the end of the line. */
function closing(line: string, from: number, char: string): number {
  const at = line.indexOf(char, from);
  return at === -1 ? line.length : at;
}
