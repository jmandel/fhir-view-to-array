# fhir-view-to-array

Web demo at https://joshuamandel.com/fhir-view-to-array/

Or run CLI with Deno...

###  Generate a CSV file

```sh
cat pt.ndjson | \
deno run --allow-read generate-table.ts \
  --config patient-contacts-config.json \
  --stdin \
> contacts.csv
```

Or pass a series of `--infile filename.ndjson` arguments to read from the filesystem.

###  Generate a sqlite table

Add or replace a table in `analysis.db` (creating the file if necessary)

```sh
deno run --allow-read --allow-write generate-table.ts \
  --config patient-contacts-config.json \
  --infile pt.ndjson \
  --sqlite analysis.db
```

Use `--append` flag to append to an existing table.
