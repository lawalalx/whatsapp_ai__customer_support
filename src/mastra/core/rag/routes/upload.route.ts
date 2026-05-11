import express from "express";
import multer from "multer";
import fs from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import { processAndStore } from "../process-and-store";
import { insertDoc } from "../db";

const router = express.Router();

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split(".").pop()?.toLowerCase();
    const allowed = ["pdf", "txt", "csv", "docx", "doc", "xlsx", "xls"];
    if (!ext || !allowed.includes(ext)) {
      return cb(new Error(`Unsupported file type: .${ext}. Allowed: ${allowed.join(", ")}`));
    }
    cb(null, true);
  },
});

/**
 * @swagger
 * /api/kb/upload:
 *   post:
 *     summary: Upload one or more documents to the knowledge base
 *     description: |
 *       Upload one or more files **or** supply raw text.
 *       Supported formats: **PDF, TXT, CSV, DOCX, DOC, XLSX, XLS**.
 *       Each document is chunked, embedded, and added to the vector index.
 *       Existing documents are NOT affected — new documents are appended.
 *       
 *       ⚠️ You cannot send both files and text in the same request.
 *     tags:
 *       - Knowledge Base
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: One or more files (PDF, TXT, CSV, DOCX, DOC, XLSX, XLS)
 *               text:
 *                 type: string
 *                 description: Plain text content (alternative to file upload)
 *               title:
 *                 type: string
 *                 description: Optional human-readable title for the document
 *     responses:
 *       200:
 *         description: All documents indexed successfully
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               count: 2
 *               results:
 *                 - docId: "550e8400-e29b-41d4-a716-446655440000"
 *                   filename: "faq.pdf"
 *                   totalChunks: 12
 *                 - docId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
 *                   filename: "product-guide.txt"
 *                   totalChunks: 8
 *       400:
 *         description: Invalid input
 *       500:
 *         description: Server error
 */
router.post("/", upload.array("files"), async (req, res) => {
  try {
    const { text, title } = req.body;
    const files = req.files as Express.Multer.File[];

    if ((!files || files.length === 0) && !text) {
      return res.status(400).json({ success: false, error: "Provide either files or text" });
    }
    if (files?.length > 0 && text) {
      return res.status(400).json({ success: false, error: "Provide either files OR text, not both" });
    }

    const inputs: Array<{ filePath: string; originalName: string; size?: number; isTemp: boolean }> = [];

    if (text) {
      const tmpPath = `uploads/text_${Date.now()}.txt`;
      await fs.outputFile(tmpPath, text);
      inputs.push({ filePath: tmpPath, originalName: `text_${Date.now()}.txt`, isTemp: true });
    } else {
      for (const file of files) {
        inputs.push({
          filePath: file.path,
          originalName: file.originalname,
          size: file.size,
          isTemp: false,
        });
      }
    }

    const results = [];
    for (const inp of inputs) {
      const docId = uuidv4();
      const result = await processAndStore({
        filePath: inp.filePath,
        docId,
        originalName: inp.originalName,
      });
      await insertDoc({
        docId,
        title: title ?? undefined,
        originalName: inp.originalName,
        filePath: inp.filePath,
        size: inp.size,
      });
      if (inp.isTemp) await fs.remove(inp.filePath);
      results.push(result);
    }

    return res.json({ success: true, count: results.length, results });
  } catch (err: any) {
    console.error("[upload] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
