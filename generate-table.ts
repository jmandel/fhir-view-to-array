// generate-table.ts

import { parse } from "https://deno.land/std@0.184.0/flags/mod.ts";
import { processResources, fromNdjsonResponse } from "./processor.js";

const args = parse(Deno.args);

if (!args.config) {
  console.error("Usage: cat pt.ndjson | deno run --allow-read generate-table.ts --config patient-contacts-config.json");
  Deno.exit(1);
}

const configPath = args.config;
const configFile = await Deno.readTextFile(configPath);
const config = JSON.parse(configFile);

async function main() {
  const resourceGenerator = fromNdjsonResponse(new Response(Deno.stdin.readable));

  const processor = processResources(resourceGenerator, config);

  // Print header (column names)
  console.log(Object.keys(config.columns).map(quote).join(","));

  // Process and print rows
  for await (const row of processor) {
    console.log(row.map(quote).join(","));
  }
}

function quote(value) {
  const escaped = (value || "").toString().replace(/"/g, '""');
  return `"${escaped}"`;
}

await main();
