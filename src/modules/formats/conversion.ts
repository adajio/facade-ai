import { ConverterPortError, converterImage, convertBytes } from "../converter-port/index.js";
import { ReaderError } from "../pdf/types.js";
import { FormatHold } from "./model.js";

export type Legacy = "doc" | "xls" | "dwg";
type Converter = { id: string; format: Legacy };

export async function converterFor(format: Legacy): Promise<Converter | undefined> {
  try {
    const id = await converterImage(format);
    if (id) return { id, format };
  } catch (error) {
    if (!(error instanceof ConverterPortError)) throw error;
    if (error.code !== "unavailable") {
      throw new ReaderError(`converter_${error.code}`, "Брокер конвертации временно недоступен", 503);
    }
  }
}

export async function convert({ id, format }: Converter, input: Buffer) {
  try {
    return await convertBytes(format, input, { image: id });
  } catch (error) {
    if (!(error instanceof ConverterPortError)) throw error;
    const code = `converter_${error.code}`;
    if (["unavailable", "busy", "scratch_unavailable"].includes(error.code)) {
      throw new ReaderError(code, "Конвертация ожидает доступного брокера или рабочих ресурсов", 503);
    }
    throw new FormatHold(code);
  }
}
