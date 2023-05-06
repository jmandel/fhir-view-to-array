import fhirpath from "https://cdn.skypack.dev/fhirpath@v3.3.2";

export async function* processResources(resourceGenerator, configIn) {
  const config = JSON.parse(JSON.stringify(configIn));
  ["expand", "vars", "filters", "columns"].forEach((s) => {
    config[s].forEach((r) => {
      r.$evaluate = fhirpath.compile(r.expr);
    })
  });

  for await (const resource of resourceGenerator) {
    if (
      resource.resourceType === config.resource &&
      filterResource(resource, config)
    ) {
      yield* extractColumns(resource, config);
    }
  }
}

function filterResource(resource, config) {
  return config.filters.every((expression) =>
    expression.$evaluate(resource).every((v) => !!v)
  );
}

function extractColumns(resource, config) {
  const variables = {};

  function* iterateVariables(collectionVars, context = {}) {
    if (collectionVars.length === 0) {
      const rowData = [];

      for (const col of config.columns) {
        const key = col.name;
        const value = col.$evaluate(resource, context);
        if (value.length > 1) {
          console.log("Expression returned >1 value", key, value);
        }
        rowData.push(value?.[0]);
      }
      yield rowData;
    } else {
      const currentVar = collectionVars[0];
      const remainingVars = collectionVars.slice(1);
      const currentCollection = currentVar.$evaluate(resource, context);
      for (const item of currentCollection) {
        const newContext = { ...context, [currentVar.name]: item };
        yield* iterateVariables(remainingVars, newContext);
      }
    }
  }

  const collectionVars = [...config.vars, ...config.expand];
  const result = Array.from(iterateVariables(collectionVars));
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
