import { parse } from "https://deno.land/std/flags/mod.ts";
import { processResources, fromNdjsonResponse } from "./processor.js";
import { DB } from "https://deno.land/x/sqlite/mod.ts";
import { readableStreamFromReader } from "https://deno.land/std@0.171.0/streams/mod.ts";

const args = parse(Deno.args, {collect: "infile"});

if (!args.config) {
  console.error("Usage: deno run --allow-read generate-table.ts --config myconfig.json [--sqlite mydb.sqlite] [--table mytable] [--append]");
  Deno.exit(1);
}

const configPath = args.config;
const configFile = await Deno.readTextFile(configPath);
const config = JSON.parse(configFile);

const useSqlite = !!args.sqlite;
const sqliteFile = args.sqlite;
const append = !!args.append;
const stdin = !!args.stdin;
const infile = args.infile;

const tableName = args.table || config.view || config.name || "output_table";

if (useSqlite && !tableName) {
  console.error("Please provide a table name with --table option");
  Deno.exit(1);
}

async function main() {

  const sources = [
    ...(infile || []).map(f => readableStreamFromReader(Deno.openSync(f, {read: true}))),
    ...(stdin ? [Deno.stdin.readable] : [])
  ]

  async function* resources(streams) {
    for (const s of streams ) {
      yield* fromNdjsonResponse(new Response(s));
    }
  }

  const processor = processResources(resources(sources), config);

  if (useSqlite) {
    const db = new DB(sqliteFile);
    db.execute("BEGIN TRANSACTION")
    createTable(db, tableName, config.columns, append);
    await insertData(db, tableName, config.columns, processor);
    db.execute("END")
    db.close()
  } else {
    printCsv(config.columns, processor);
  }
}

async function printCsv(columns, processor) {
  console.log(columns.map(c => c.name).map(quote).join(","));
  for await (const row of processor) {
    console.log(row.map(quote).join(","));
  }
}

function createTable(db, tableName, columns, append) {
  const columnDefs = columns.map((col) => `${col.name} TEXT`).join(", ");
  if (!append) {
    db.execute(`DROP TABLE IF EXISTS ${tableName}`);
  }
  db.execute(`CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs})`);
}

async function insertData(db, tableName, columns, processor) {
  const placeholders = columns.map(() => "?").join(", ");
    const q = db.prepareQuery(`INSERT INTO ${tableName} VALUES (${placeholders})`)
    for await (const row of processor) {
      q.execute(row);
    }
    q.finalize()
}

function quote(value) {
  const escaped = (value || "").toString().replace(/"/g, '""');
  return `"${escaped}"`;
}

await main();
