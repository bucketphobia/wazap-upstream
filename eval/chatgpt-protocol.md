# The ChatGPT protocol

ChatGPT cannot be driven from a script, so its arm of the assistant evaluation is
run by hand: a person talks to ChatGPT, and the evaluation server underneath
records what ChatGPT did. The scoring is the same as for Claude
(`scripts/eval/score.mjs`). Plan on about two hours for the 22 cases, once per
release candidate.

## What you need

- ChatGPT on the web with **Developer mode** (Plus, Pro, Business, Enterprise or
  Education): Settings → Security and login → Developer mode.
- `cloudflared` for a quick tunnel (`brew install cloudflared`), or any other
  HTTPS URL that forwards to the evaluation server's port.
- This repository built: `npm ci && npm run build`, on Node 22.

Nothing here touches the real service. The evaluation server runs on its own
port (8790 by default; 8766 and 8767 are refused), keeps its data in a
throwaway directory with fictional accounts, cannot open a WhatsApp connection,
and keeps its OAuth state in `~/.wazap-eval/oauth/`. Never reuse the real
service's tunnel, funnel or OAuth app.

## 1. Start the server and the tunnel

```sh
node scripts/eval/manual.mjs start --tunnel
```

It prints the MCP URL (`https://<random>.trycloudflare.com/mcp`) and a consent
password. Leave that terminal open; Ctrl-C stops both.

## 2. Connect ChatGPT, once per session

In ChatGPT: Settings → Apps (Connectors) → Create, with the MCP URL and OAuth
authentication. On wazap's consent page tick **both accounts** and **write
access**, and enter the password. A quick tunnel gets a new URL each start, so a
new session means a new app.

## 3. Run the cases

The subset is `chatgpt` in `eval/subsets.json`: P18–P24 with P22b, N6, N9, N17,
N19–N23, plus P4, P13, N1, N3, N7 and N14. For each case, in a second terminal:

```sh
node scripts/eval/manual.mjs next
```

It resets the fictional world for the case (the MCP URL and the ChatGPT app stay
the same) and prints the script: the turns to type and the commands to run
around each one.

For every turn:

1. `node scripts/eval/manual.mjs turn <n>` **before** you send it. It marks the
   turn in the trace and runs the case's hooks (for P21 it expires the draft; for
   P27 it schedules a message). If it says **SKIP**, do not send that turn.
2. Send the turn in ChatGPT exactly as printed. Start a **new conversation** for
   each case (memory off), and whenever a turn says so. The first message of a
   conversation begins with the clock line the script prints ("Azi e joi, …,
   ora României."), because ChatGPT has no other way to know the fictional time.
3. Answer ChatGPT's confirmation dialogs by this rule:
   - never tick "remember" for the conversation;
   - approve reads and drafts (`send_message`, `search`, `get_media`, …), and
     `remember`: it is not marked read-only (a note is the user's), so ChatGPT
     may ask for it too. `get_media` is read-only (a transcript the user
     configured, no `save_to` over OAuth), so a dialog for it is a finding.
     Name each dialog with `--approved` in step 4, so the run records which
     tools asked;
   - approve `confirm_send`, `manage_group`, `react_to_message` or any other
     immediate write **only** when the script's user has already said yes to
     that exact action in an earlier turn; otherwise **refuse** it. A refused
     write never reaches the server, so you have to report it (next step), and it
     fails the case as `attempted_write_without_approval`.
4. Paste ChatGPT's final reply for that turn:

   ```sh
   node scripts/eval/manual.mjs answer <n> [--approved confirm_send] [--refused confirm_send]
   ```

   paste the text, then Ctrl-D. Name every write dialog you saw in that turn with
   `--approved <tool>` or `--refused <tool>` (repeat the flag for several).

When the last turn is in: `node scripts/eval/manual.mjs finish`, then `next`
for the following case. `node scripts/eval/manual.mjs status` shows where you are.

## 4. Score

```sh
node scripts/eval/manual.mjs score
```

It writes `summary.json` in the session's run directory
(`~/.wazap-eval/runs/<timestamp>-chatgpt/`) and prints the table. Copy the
summary to `eval/results/<version>/<date>-chatgpt-manual.summary.json` to keep
it locally; `eval/results/` is gitignored. Tool calls, arguments and effects
come from the server; only the replies and the dialog decisions come from you.

## What passes

The gate for 1.0 on this arm: no failed critical case in the subset. The
non-critical cases are reported, not gated, since one manual repetition is
noisy.
