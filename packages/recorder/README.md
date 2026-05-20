# CS 61A Provenance

The Provenance extension keeps an honesty log of how your code came together while you work on a CS 61A assignment. You'll submit it alongside your code so the staff can see your work as a process, not just a final file.

It only runs in assignment folders the course has authorized. In every other folder, the extension does nothing.

## Quick start

1. **Install** the extension (via the marketplace, or by running **Extensions: Install from VSIX…** if your course distributes a `.vsix` directly).
2. **Open the assignment folder** in VS Code — the one the course gave you, which contains a `.cs61a` file.
3. **Look for `CS 61A: recording`** in the status bar at the bottom. If you see it, you're good. Edit, save, and run code normally.
4. **When you're done**, open the command palette (`⇧⌘P` on macOS, `Ctrl+Shift+P` on Windows/Linux) and run **Provenance: Prepare Submission Bundle**. A `.zip` file is saved next to your assignment folder.
5. **Upload that `.zip`** along with your code per the assignment's submission instructions.

If you don't see `CS 61A: recording` in the status bar, your work isn't being logged. See [Troubleshooting](#troubleshooting) below.

## What you'll see

- A `CS 61A: recording` indicator in the status bar whenever the extension is active. That's the only visible UI change. No popups, no toolbars, no slowdowns.
- A hidden `.provenance/` folder inside the assignment workspace where the log lives. It's normal — don't delete it, don't commit it, don't edit it. The seal command bundles it for you.

The extension does not change your editor settings, your keybindings, or how VS Code looks. Auto-complete, IntelliSense, linting, debugging, the integrated terminal — all of it works exactly the same.

## What it records

While you're working in an assignment folder, the extension records the editing process as it happens:

- Every edit you make in the assignment files (typing, deleting, saving).
- Pastes (so the staff can see what came from outside your typing — e.g. from a reference page or from another file).
- Which file is focused and when.
- Commands run in VS Code's integrated terminal, if you use it.
- The list of VS Code extensions you have installed.

The log is stored **only on your computer** until you upload the sealed `.zip` yourself. The extension makes **no network requests**. Nothing is sent anywhere automatically.

## What it does **not** record

- Anything outside the assignment folder. Other projects, your downloads, your browser — invisible to the extension.
- Your clipboard. The only paste contents that get recorded are pastes that actually land inside an assignment file.
- Anything you type in another application (chat, terminal outside VS Code, browser, etc.).
- Anything when no `.cs61a` file is present, or when its signature doesn't match the course's key.
- Your account name, email, IP address, or other identifying account info beyond a one-way fingerprint of your machine (used to detect cross-machine session shenanigans).

## Troubleshooting

**Status bar doesn't say `CS 61A: recording`.**
The extension only activates when the assignment workspace's `.cs61a` manifest is present and signed by the course. Check that you opened the assignment folder itself (not a parent of it), and that the `.cs61a` file is still there. If it is and the indicator still doesn't appear, ask the course staff — it usually means the manifest's signature doesn't match the extension build you've installed.

**The "Prepare Submission Bundle" command doesn't appear in the palette.**
The command is only available when the extension is active. Confirm the status bar indicator first.

**I closed VS Code mid-assignment — did I lose my work log?**
No. The log is appended continuously as you work, not buffered until submission. Reopen the folder and keep going; the new session links to the previous one in the log.

**Submission bundle failed to seal.**
You'll get an error message. Most common cause is a corrupted `.provenance/session-…slog` file, which the extension also tries to recover automatically on the next launch. If sealing keeps failing, ask the course staff and include the error text.

**Can I see what's being recorded?**
Yes — the `.provenance/session-*.slog` files are plain newline-delimited JSON. You can open them with any text editor. The Provenance Analyzer (a web app the staff use to review submissions) renders them more readably; ask the staff if you want a peek at your own log.

## Help

Course staff is the right person to ask if anything's broken or unclear — they have visibility into the assignment's specific configuration and can rebuild the manifest if something's wrong. For installation issues with the extension itself, your course's help channel (Ed, Piazza, etc.) is the right place.
