# fhir-view-to-array

Web demo at https://joshuamnadel.com/fhir-view-to-array

Or run CLI with Deno

```sh
cat pt.ndjson | \
deno run --allow-read generate-table.ts \
  --config patient-contacts-config.json \
> contacts.csv
```