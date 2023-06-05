if (!window.fhirpath) {
  await import("./vendor/fhirpath.js");
}

export async function* processResources(resourceGenerator, configIn) {
  const config = JSON.parse(JSON.stringify(configIn));
  const context = (config.constants || []).reduce((acc, next) => {
    acc[next.name] = next.value;
    return acc;
  }, {});
  compileViewDefinition(config);
  for await (const resource of resourceGenerator) {
    for (const matchingResource of config.$from(resource, context)) {
      yield* extract(matchingResource, config, context);
    }
  }
}

export function getColumns(viewDefinition) {
  return (viewDefinition.select || []).flatMap((c) => {
    if (c.expr) {
      return [c];
    }
    if (c.select) {
      return getColumns(c);
    }
    return [];
  });
}

function compile(e) {
  const e2 = (e === "$this") ? "trace()" : e;
  return fhirpath.compile(e2);
}
function compileViewDefinition(viewDefinition) {
  if (viewDefinition.expr) {
    viewDefinition.$expr = compile(viewDefinition.expr)
  }
  if (viewDefinition.from) {
    viewDefinition.$from = compile(viewDefinition.from);
  }
  if (viewDefinition.forEach || viewDefinition.foreach) {
    viewDefinition.$forEach = compile(
      viewDefinition.forEach || viewDefinition.foreach
    );
  }

  for (let field of viewDefinition.select || []) {
    compileViewDefinition(field);
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

function extractFields(obj, viewDefinition, context = {}) {
  let fields = [];
  for (let field of viewDefinition) {
    let { name, $expr, $forEach, select, $from } = field;
    if (name && $expr) {
      fields.push([{ [name]: $expr(obj)[0], context }]);
    } else if ($forEach && select) {
      let nestedObjects = $forEach(obj);
      let rows = [];
      for (let nestedObject of nestedObjects) {
        rows.push(...extract(nestedObject, { select }, context));
      }
      fields.push(rows);
    } else if ($from && select) {
      let nestedObject = $from(obj);
      fields.push(extract(nestedObject, { select }, context));
    } else {
      console.error("Bad expr", viewDefinition);
    }
  }
  return fields;
}

function* extract(obj, viewDefinition, context = {}) {
  let fields = extractFields(obj, viewDefinition.select);
  for (let combination of cartesianProduct(fields)) {
    let row = Object.assign({}, ...combination);
    yield row;
  }
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
