import fs from "fs";
import path from "path";
import axios from "axios";

// AUTO CREATE
const DB_DIR = "./database";
const EXT_DIR = "./database/external-plugins";
const DB_FILE = "./database/external.json";

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, {
    recursive: true
  });
}

if (!fs.existsSync(EXT_DIR)) {
  fs.mkdirSync(EXT_DIR, {
    recursive: true
  });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify({}, null, 2)
  );
}

// GET DB
function getDB() {

  return JSON.parse(
    fs.readFileSync(DB_FILE)
  );
}

// SAVE DB
function saveDB(data) {

  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(data, null, 2)
  );
}

// INSTALL PLUGIN
export async function installExternalPlugin(
  user,
  url
) {

  const { data } =
    await axios.get(url);

  // SECURITY CHECK
  const blocked = [
    "child_process",
    "process.exit",
    "unlinkSync",
    "rmSync",
    "fs.rm",
    "fs.rmdir"
  ];

  if (
    blocked.some(x =>
      data.includes(x)
    )
  ) {
    throw new Error(
      "Unsafe Plugin"
    );
  }

  // COMMAND DETECT
  const match =
    data.match(
      /command\s*:\s*["'`](.*?)["'`]/
    );

  if (!match) {
    throw new Error(
      "Command not found"
    );
  }

  const command =
    match[1]
      .trim()
      .split(" ")[0]
      .toLowerCase();

  // USER FOLDER
  const userDir =
    path.join(
      EXT_DIR,
      user
    );

  if (
    !fs.existsSync(userDir)
  ) {
    fs.mkdirSync(userDir, {
      recursive: true
    });
  }

  // FIX IMPORT PATH
  let code = data;

  code = code.replace(
    /from\s+["']\.\.\/lib\/plugins\.js["']/g,
    `from "../../../lib/plugins.js"`
  );

  // FILE PATH
  const filePath =
    path.join(
      userDir,
      `${command}.js`
    );

  // SAVE FILE
  fs.writeFileSync(
    filePath,
    code
  );

  // SAVE DB
  const db = getDB();

  if (!db[user]) {
    db[user] = {};
  }

  db[user][command] = {
    command,
    file: filePath,
    url,
    installedAt: Date.now()
  };

  saveDB(db);

  return command;
}

// GET PATH
export function getExternalPluginPath(
  user,
  command
) {

  const db = getDB();

  return (
    db[user]?.[command]
      ?.file || null
  );
}

// REMOVE
export function removeExternalPlugin(
  user,
  command
) {

  const db = getDB();

  const info =
    db[user]?.[command];

  if (!info) {
    throw new Error(
      "Plugin not found"
    );
  }

  // DELETE FILE
  if (
    fs.existsSync(info.file)
  ) {
    fs.unlinkSync(info.file);
  }

  // REMOVE DB
  delete db[user][command];

  saveDB(db);

  return true;
}

// LIST
export function listExternalPlugins(
  user
) {

  const db = getDB();

  return Object.keys(
    db[user] || {}
  );
}
