/* ============================================================
   Houses & Humans — SQLite layer (Phase 1: users + adventures)
   ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function createDb(dbPath) {
  const db = new Database(dbPath || ":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schemaPath = path.join(__dirname, "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  return db;
}

module.exports = { createDb };
