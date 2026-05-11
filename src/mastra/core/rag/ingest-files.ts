import fs from "fs-extra";
import csvParser from "csv-parser";

/**
 * Extracts plain text from PDF, TXT, CSV, DOCX, DOC, XLSX, XLS files.
 * @param originalName - The original filename (used to determine file type, since temp paths have no extension)
 */
export async function extractText(filePath: string, originalName?: string): Promise<string> {
  const nameForExt = originalName ?? filePath;
  const ext = nameForExt.split(".").pop()?.toLowerCase();

  if (ext === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const buffer = await fs.readFile(filePath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return result.text;
  }

  if (ext === "txt") {
    return fs.readFile(filePath, "utf-8");
  }

  if (ext === "csv") {
    return new Promise((resolve, reject) => {
      let result = "";
      fs.createReadStream(filePath)
        .pipe(csvParser())
        .on("data", (row: Record<string, unknown>) => {
          result += Object.values(row).join(" ") + "\n";
        })
        .on("end", () => resolve(result))
        .on("error", reject);
    });
  }

  if (ext === "docx" || ext === "doc") {
    const mammoth = await import("mammoth");
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === "xlsx" || ext === "xls") {
    const xlsxMod = await import("xlsx");
    // Dynamic import may wrap the CommonJS module under `.default`
    const XLSX = (xlsxMod as any).default ?? xlsxMod;
    const buffer = await fs.readFile(filePath);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const lines: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        defval: "",
      }) as Record<string, unknown>[];
      for (const row of rows) {
        lines.push(Object.values(row).join(" "));
      }
    }
    return lines.join("\n");
  }

  throw new Error(`Unsupported file type: .${ext}. Allowed: pdf, txt, csv, docx, doc, xlsx, xls`);
}
