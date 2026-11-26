import { FormatHold } from "./model.js";

const recoveryFields = new Set(["entity", "entmode", "ins_pt", "height", "rotation", "handle", "text", "text_value"]);
const punctuation = /^[{}\[\]:,]$/u;

function invalid(): never {
  throw new FormatHold("dwg_recovery_invalid");
}

async function* jsonTokens(source: AsyncIterable<string>): AsyncGenerator<string> {
  const token = /[{}\[\]:,]|"(?:[^"\\]|\\[\s\S])*"|[^\r\n\t {}\[\]:,"]+|[ \r\n\t]+/uy;
  let pending = "";
  function* scan(text: string, final: boolean) {
    let offset = 0;
    while (offset < text.length) {
      token.lastIndex = offset;
      const match = token.exec(text);
      if (!match || (!final && token.lastIndex === text.length && !punctuation.test(match[0]))) break;
      offset = token.lastIndex;
      if (!/^[ \r\n\t]/u.test(match[0])) yield match[0];
    }
    pending = text.slice(offset);
    if (pending.length > 1024 ** 2) throw new FormatHold("dwg_recovery_token_limit");
  }
  for await (const chunk of source) yield* scan(pending + chunk, false);
  yield* scan(pending, true);
  if (pending) invalid();
}

function literal(token: string): unknown {
  try {
    return JSON.parse(token);
  } catch {
    return invalid();
  }
}

export async function* recoveryObjects(source: AsyncIterable<string>): AsyncGenerator<unknown> {
  const tokens = jsonTokens(source);
  const next = async () => (await tokens.next()).value;
  async function expect(token: string) {
    if ((await next()) !== token) invalid();
  }
  async function key(token: string | undefined) {
    if (!token?.startsWith('"')) return invalid();
    await expect(":");
    return literal(token) as string;
  }

  async function value(token: string | undefined, depth: number, limit = 0): Promise<unknown> {
    if (token === undefined || depth > 64) return invalid();
    if (token === "[") {
      const array: unknown[] = [];
      let item = await next();
      if (item === "]") return array;
      for (let index = 0; ; index++) {
        const entry = await value(item, depth + 1);
        if (index < limit) array.push(entry);
        item = await next();
        if (item === "]") return array;
        if (item !== ",") return invalid();
        item = await next();
      }
    }
    if (token === "{") {
      let item = await next();
      if (item === "}") return undefined;
      while (true) {
        await key(item);
        await value(await next(), depth + 1);
        item = await next();
        if (item === "}") return undefined;
        if (item !== ",") return invalid();
        item = await next();
      }
    }
    if (punctuation.test(token)) return invalid();
    return literal(token);
  }

  async function object(token: string | undefined) {
    if (token !== "{") return value(token, 1);
    const record: Record<string, unknown> = {};
    let item = await next();
    if (item === "}") return record;
    while (true) {
      const name = await key(item);
      const size = name === "ins_pt" ? 2 : name === "handle" ? 3 : 0;
      const entry = await value(await next(), 2, size);
      if (recoveryFields.has(name)) record[name] = entry;
      item = await next();
      if (item === "}") return record;
      if (item !== ",") return invalid();
      item = await next();
    }
  }

  try {
    await expect("{");
    let objects = false;
    let item = await next();
    while (item !== "}") {
      const name = await key(item);
      if (name === "OBJECTS") {
        if (objects) invalid();
        objects = true;
        await expect("[");
        item = await next();
        if (item !== "]") {
          while (true) {
            yield await object(item);
            item = await next();
            if (item === "]") break;
            if (item !== ",") invalid();
            item = await next();
          }
        }
      } else {
        await value(await next(), 1);
      }
      item = await next();
      if (item === "}") break;
      if (item !== ",") invalid();
      item = await next();
      if (item === "}") invalid();
    }
    if (!objects || await next() !== undefined) {
      invalid();
    }
  } finally {
    await tokens.return(undefined);
  }
}
