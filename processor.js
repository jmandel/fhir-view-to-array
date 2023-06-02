if (!window.fhirpath){
  await import("./vendor/fhirpath.js");
}

export async function* processResources(resourceGenerator, configIn) {
  const config = JSON.parse(JSON.stringify(configIn));
  ["vars", "filters", "columns"].forEach((s) => {
    config[s] &&
      config[s].forEach((r) => {
        r.$evaluate = fhirpath.compile(r.expr);
        r.whenMultiple = r.whenMultiple || "error";
      });
  });

  for await (const resource of resourceGenerator) {
    if (resource.resourceType === config.resource) {
      yield* extractColumns(resource, config);
    }
  }
}


function* cartesianProduct(arrays) {
  if (arrays.length === 0) {
    yield [];
  } else {
    let [first, ...rest] = arrays;
    for (let item of first) {
      for (let items of cartesianProduct(rest)) {
        yield [item, ...items];
      }
    }
  }
}

function extractFields(viewDefinition, obj) {
  let fields = [];
  for (let field of viewDefinition) {
    let { name, expr, forEach, select, from: fromField } = field;
    if (name && expr) {
      fields.push([{ [name]: fhirpath.evaluate(obj, expr)[0] }]);
    }
    else if (forEach && select) {
      let nestedObjects = fhirpath.evaluate(obj, forEach);
      let rows = [];
      for (let nestedObject of nestedObjects) {
        rows.push(...extract({ select }, nestedObject));
      }
      fields.push(rows);
    }
    else if (fromField && select) {
      let nestedObject = fhirpath.evaluate(obj, fromField);
      fields.push(extract({ select }, nestedObject ));
    } else {
      console.error("Bad expr", viewDefinition);
    }
  }
  return fields;
}

function* extract(viewDefinition, obj) {
  let fields = extractFields(viewDefinition.select, obj);
  for (let combination of cartesianProduct(fields)) {
    let row = Object.assign({}, ...combination);
    yield row;
  }
}

function filterResource(resource, config, context) {
  return config.filters.every((expression) =>
    expression.$evaluate(resource, context).every((v) => !!v)
  );
}

function extractColumns(resource, config) {
  const variables = {};

  function* iterateVariables(collectionVars, context = { resource }) {
    if (collectionVars.length === 0) {
      if (!filterResource(resource, config, context)) {
        return;
      }
      const rowData = [];
      for (const col of config.columns) {
        const key = col.name;
        const value = col.$evaluate(resource, context);
        if (value.length > 1 && col.whenMultiple !== "array") {
          console.error("Expression returned >1 value", key, value);
        }
        rowData.push(col.whenMultiple === "array" ? value : value?.[0]);
      }
      yield rowData;
    } else {
      const currentVar = collectionVars[0];
      const remainingVars = collectionVars.slice(1);
      const currentCollection = currentVar.$evaluate(resource, context);
      if (currentCollection.length > 1 && currentVar.whenMultiple === "error") {
        console.error(
          `Error, expected single rows from ${JSON.stringify(currentVar)}`,
        );
      }
      if (
        currentCollection.length > 1 &&
        currentVar.whenMultiple === "unnest" &&
        currentVar.expr[0] !== "%"
      ) {
        console.error(
          `Error, expected rows from ${
            JSON.stringify(
              currentVar,
            )
          } to unnest from an existing variable`,
        );
      }
      for (const item of currentCollection) {
        const newContext = { ...context, [currentVar.name]: item };
        yield* iterateVariables(remainingVars, newContext);
      }
    }
  }

  const result = Array.from(iterateVariables(config.vars));
  return result;
}

export async function* fromUrl(url) {
  const response = await fetch(url);
  yield* fromNdjsonResponse(response);
}

export async function* fromFile(file) {
  const response = new Response(file);
  yield* fromNdjsonResponse(response);
}

export async function* fromNdjsonResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      // Process the remaining buffer content when done
      if (buffer) {
        yield JSON.parse(buffer);
      }
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep the last (potentially incomplete) line in the buffer

    for (const line of lines) {
      if (!line) {
        continue;
      }
      yield JSON.parse(line);
    }
  }
}
