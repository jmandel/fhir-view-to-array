import fhirpath from "https://cdn.skypack.dev/fhirpath@v3.3.2";

export async function* processResources(resourceGenerator, configIn) {
  const config = JSON.parse(JSON.stringify(configIn));
  ["variables", "filters", "columns"].forEach((s) => {
    Object.keys(config[s]).forEach((k) => {
      config[s][k] = fhirpath.compile(config[s][k]);
    });
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
    expression(resource).every((v) => !!v)
  );
}

function extractColumns(resource, config) {
  const variables = {};

  function* iterateVariables(collectionKeys, context = {}) {
    if (collectionKeys.length === 0) {
      const rowData = [];

      for (const key in config.columns) {
        const expression = config.columns[key];
        const value = expression(resource, context);
        if (value.length > 1) {
          console.log("Expression returned >1 value", key, value);
        }
        rowData.push(value?.[0]);
      }
      yield rowData;
    } else {
      const currentKey = collectionKeys[0];
      const remainingKeys = collectionKeys.slice(1);
      const expression = config.variables[currentKey];
      const currentCollection = expression(resource, context);
      for (const item of currentCollection) {
        const newContext = { ...context, [currentKey]: item };
        yield* iterateVariables(remainingKeys, newContext);
      }
    }
  }

  const collectionKeys = Object.keys(config.variables);
  const result = Array.from(iterateVariables(collectionKeys));
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
