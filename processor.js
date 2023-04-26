import fhirpath from "https://cdn.skypack.dev/fhirpath@v3.3.2";

export async function* processResources(resourceGenerator, config) {
  for await (const resource of resourceGenerator) {
    if (
      resource.resourceType === config.resource &&
      filterResource(resource, config)
    ) {
      const rowData = extractColumns(resource, config);
      for (const row of rowData) {
        yield row;
      }
    }
  }
}

function filterResource(resource, config) {
  return config.filter.every((expression) =>
    fhirpath.evaluate(resource, expression, null).every((v) => !!v)
  );
}

function extractColumns(resource, config) {
  const collections = {};

  function* iterateCollections(collectionKeys, context = {}) {
    if (collectionKeys.length === 0) {
      const rowData = [];

      for (const key in config.columns) {
        const expression = config.columns[key];
        const value = fhirpath.evaluate(resource, expression, context);
        if (value.length > 1) {
          console.log("Expression returned >1 value", key, value);
        }
        rowData.push(value?.[0]);
      }

      yield rowData;
    } else {
      const currentKey = collectionKeys[0];
      const remainingKeys = collectionKeys.slice(1);
      const expression = config.collections[currentKey];
      const currentCollection = fhirpath.evaluate(
        resource,
        expression,
        context
      );

      for (const item of currentCollection) {
        const newContext = { ...context, [currentKey]: item };
        yield* iterateCollections(remainingKeys, newContext);
      }
    }
  }

  const collectionKeys = Object.keys(config.collections);
  const result = Array.from(iterateCollections(collectionKeys));
  return result;
}

export async function* fetchResourcesFromUrl(url) {
  const response = await fetch(url);
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

export async function* readResourcesFromFile(file) {
  const text = await file.text();
  const lines = text.split("\n");

  for (const line of lines) {
    if (!line) {
      continue;
    }

    yield JSON.parse(line);
  }
}

