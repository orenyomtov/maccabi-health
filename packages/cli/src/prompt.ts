/** Small TTY-only prompt; entered credentials never appear in argv, history, or echo. */
export function terminalPrompt(label: string, hidden = false): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY || !output.isTTY) return Promise.reject(new Error("INTERACTIVE_TERMINAL_REQUIRED"));
  return new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const previousRaw = input.isRaw;
    const finish = (cancelled = false) => {
      if (finished) return;
      finished = true;
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      input.setRawMode(previousRaw);
      input.pause();
      output.write("\n");
      cancelled ? reject(new Error("INPUT_CANCELLED")) : resolve(value);
    };
    const onError = () => finish(true);
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (finished) break;
        if (character === "\r" || character === "\n") finish();
        else if (character === "\x03" || character === "\x04") finish(true);
        else if (character === "\x7f" || character === "\b") {
          if (value.length) { value = value.slice(0, -1); output.write("\b \b"); }
        } else if (character >= " " && character !== "\x1b" && value.length < 128) {
          value += character;
          output.write(hidden ? "*" : character);
        }
      }
    };
    output.write(label);
    input.setRawMode(true);
    input.on("data", onData);
    input.on("error", onError);
    input.resume();
  });
}
