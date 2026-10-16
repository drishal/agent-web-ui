// One line to paste into a terminal: `cd <folder> && <program> <args…>`, for
// "Copy resume command". Quoted so the same line works in bash, zsh, and fish
// (the maintainer's shell): plain words stay bare, anything else goes in
// single quotes, and a single quote inside becomes '\'' (close, an escaped
// quote, reopen), which all three read the same way.

/** A word needing no quotes: no spaces, globs, expansions, or quotes in any of the three shells. */
const BARE = /^[A-Za-z0-9_\-+=.,/:@%]+$/;

/** One argument, quoted only when it has to be. */
export function shellWord(word: string): string {
  if (BARE.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Change to `cwd`, then run the command, as one line. */
export function shellLine(cwd: string, argv: string[]): string {
  return `cd ${shellWord(cwd)} && ${argv.map(shellWord).join(" ")}`;
}
