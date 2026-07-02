import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
const envPath = path.join(__dirname, "config.env");
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Set NODE_ENV to production if not already set
process.env.NODE_ENV = process.env.NODE_ENV || "production";

// Helper to parse boolean values
const isTrue = (x) => x === "true" || x === true;

// Database URL
const DB_URL = process.env.DATABASE_URL || "";

// Auth directory - use writable location for hosting environments
// Default to /tmp/auth (writable in most environments) or configurable via AUTH_DIR env var
const AUTH_DIR =
  process.env.AUTH_DIR || path.join(process.cwd(), "tmp", "auth");

// Export config
export default {
  prefix: process.env.PREFIX || ".",
  owner: process.env.OWNER_NUMBER || "917074029156",
  sudo: process.env.SUDO || "917074029156",
  packname: process.env.PACKNAME || "𝐗𝐦𝐝",
  author: process.env.AUTHOR || "𝐌𝐫 𝐑𝐚𝐛𝐛𝐢𝐭",
  SESSION_ID: process.env.SESSION_ID || "",
  THEME: process.env.THEME || "t",
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 100 * 1024 * 1024, // 100MB default
  timezone: process.env.TIMEZONE || "UTC",
  GIST_URL: process.env.GIST_URL || "",
  MONGODB_URI: process.env.MONGODB_URI || "",
  WORK_TYPE: process.env.WORK_TYPE || "public",
  STATUS_REACT: isTrue(process.env.STATUS_REACT) || false,
  AUTH_DIR,
};
