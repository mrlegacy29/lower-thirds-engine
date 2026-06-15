# How to import this into Claude Code

You've got this folder as a zip. Here's how to get it into Claude Code and what
to say first.

## 1. Unzip it somewhere permanent

Put the `lower-thirds-engine` folder where you keep projects, e.g.
`C:\Users\you\projects\lower-thirds-engine`. (Not in Downloads — you'll be
committing this to GitHub and building from it.)

## 2. Open it in Claude Code

Pick whichever you use:

- **Claude Code CLI:** open a terminal in the folder and run `claude`.
  ```bash
  cd C:\Users\you\projects\lower-thirds-engine
  claude
  ```
- **VS Code with the Claude Code extension:** File → Open Folder → pick the
  folder, then open the Claude Code panel.

Claude Code will read `CLAUDE.md` automatically — that's the map of the project.

## 3. First message to Claude Code

Paste this:

> Read `CLAUDE.md` and `CLAUDE_CODE_TASKS.md`. We're finalizing this into a
> downloadable Windows desktop app with GitHub-Releases auto-update. Walk me
> through the tasks in order, starting with filling in the placeholders in
> `package.json` (my GitHub username is **___**, my name is **___**). Run
> `npm install` and `npm test` and confirm everything's green before we go
> further.

Fill in your GitHub username and name where shown.

## 4. What Claude Code will do

It will, in order: fill the placeholders, install dependencies, run the test
suite, let you try `npm start`, help you push to GitHub, and then cut the first
release (which builds the Windows installer via GitHub Actions). After that,
shipping an update is just: change code → `npm test` → bump version → push tag →
the app shows a "new update available" notification.

## Notes

- **Everything is already wired** — Electron shell, the in-app relay, the
  auto-updater, the build config, the release workflow, the icon, and all 9
  passing tests. You're finalizing and releasing, not building from scratch.
- The actual graphics app is the single file **`lt.html`** — that's where new
  features go. The rest is the desktop wrapper.
- You don't need a Mac or even a Windows machine to build: the included GitHub
  Actions workflow builds the Windows installer in the cloud on every tag.
