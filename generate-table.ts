import { parse } from "https://deno.land/std/flags/mod.ts";
import { getColumns, processResources, fromNdjsonResponse, runTests } from "./processor.js";
import { DB } from "https://deno.land/x/sqlite/mod.ts";
import { readableStreamFromReader } from "https://deno.land/std@0.171.0/streams/mod.ts";

const args = parse(Deno.args, {collect: "infile"});

const configPath = args.config;
const configFile = configPath ? await Deno.readTextFile(configPath) : null;
const config = configFile ? JSON.parse(configFile) : {};
 
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

if (args.tests) {
  await tests();
} else {
  if (!args.config) {
    console.error("Usage: deno run --allow-read generate-table.ts --config myconfig.json [--sqlite mydb.sqlite] [--table mytable] [--append]");
    Deno.exit(1);
  }
  await main();
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

  const columns = getColumns(config)
  const processor = processResources(resources(sources), config);

  if (useSqlite) {
    const db = new DB(sqliteFile);
    db.execute("BEGIN TRANSACTION")
    createTable(db, tableName, columns, append);
    await insertData(db, tableName, columns, processor);
    db.execute("END")
    db.close()
  } else {
    printCsv(columns, processor);
  }
}

async function printCsv(columns, processor) {
  console.log(columns.map(c => c.name).map(quote).join(","));
  for await (const row of processor) {
    const rowQuoted = columns.map(({name}) => quote(row[name])).join(",")
    console.log(rowQuoted);
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
      q.execute(columns.map(({name}) => row[name]));
    }
    q.finalize()
}

function quote(value) {
  const escaped = (value || "").toString().replace(/"/g, '""');
  return `"${escaped}"`;
}

async function tests() {

  const sources = [
    ...(await Promise.all((infile || []).map(async (f) => await Deno.readTextFile(f)))),
    ...(stdin ? [Deno.stdin.readable] : [])
  ].map(v => JSON.parse(v) )


  for (const s of sources) {
    console.log("Run Test File", s.title);
    const result = await runTests(s);
    console.log(JSON.stringify(result, null, 2))
  }
}

