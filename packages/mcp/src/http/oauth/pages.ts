/**
 * The sign-in pages. Plain strings, no template engine, no JavaScript and no external asset, so
 * there is nothing on these pages that a browser fetches from anywhere but this process.
 */

export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const STYLE = `:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem}
main{max-width:26rem;width:100%}
h1{font-size:1.25rem;margin:0 0 .25rem}
p{margin:.25rem 0 1rem;opacity:.8}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #8888;border-radius:.4rem}
fieldset{border:1px solid #8888;border-radius:.4rem;margin:0 0 1rem}
button{margin-top:1rem;padding:.6rem 1.1rem;font:inherit;border:0;border-radius:.4rem;background:#1462b4;color:#fff;cursor:pointer}
.note{font-size:.85rem;opacity:.7}`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>
`;
}

function form(sessionId: string, csrf: string, step: string, body: string, submit: string): string {
  return `<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="session" value="${escapeHtml(sessionId)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="step" value="${escapeHtml(step)}">
${body}<button type="submit">${escapeHtml(submit)}</button></form>`;
}

export function idPage(sessionId: string, csrf: string, clientLabel: string, error?: string): string {
  return layout("Sign in to Maccabi", `<h1>Sign in to Maccabi</h1>
<p>${escapeHtml(clientLabel)} is asking to read your Maccabi health records.</p>
${errorBlock(error)}
${form(sessionId, csrf, "id", `<label for="id">ID number</label>
<input id="id" name="id" type="password" inputmode="numeric" autocomplete="off" required maxlength="9" pattern="[0-9]{1,9}">
<p class="note">Digits only. Nothing is sent until you continue.</p>`, "Continue")}`);
}

export function phonePage(sessionId: string, csrf: string, phones: { option: number; label: string }[], error?: string): string {
  const choices = phones.map((phone, index) =>
    `<label><input type="radio" name="phone" value="${phone.option}"${index === 0 ? " checked" : ""}> ${escapeHtml(phone.label)}</label>`).join("\n");
  return layout("Choose a phone", `<h1>Where should the code go?</h1>
<p>Several numbers are registered. One SMS is sent to the number you pick.</p>
${errorBlock(error)}
${form(sessionId, csrf, "phone", `<fieldset>${choices}</fieldset>`, "Send code")}`);
}

export function otpPage(sessionId: string, csrf: string, phoneLabel: string, error?: string): string {
  return layout("Enter the code", `<h1>Enter the code</h1>
<p>A six-digit code was sent to ${escapeHtml(phoneLabel)}.</p>
${errorBlock(error)}
${form(sessionId, csrf, "otp", `<label for="code">SMS code</label>
<input id="code" name="code" type="password" inputmode="numeric" autocomplete="off" required maxlength="6" pattern="[0-9]{6}">
<p class="note">One attempt only. A wrong code ends this sign-in, because repeated attempts lock the Maccabi account.</p>`, "Sign in")}`);
}

/** Terminal page. It never renders upstream text: the only interpolated value is one of our own messages. */
export function errorPage(message: string): string {
  return layout("Sign-in stopped", `<h1>Sign-in stopped</h1>
<p>${escapeHtml(message)}</p>
<p class="note">Close this window and start again from your MCP client.</p>`);
}

function errorBlock(error?: string): string {
  return error === undefined ? "" : `<p role="alert"><strong>${escapeHtml(error)}</strong></p>`;
}
