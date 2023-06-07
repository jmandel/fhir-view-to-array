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

function compile(eIn, where) {
  let e = eIn === "$this" ? "trace()" : eIn;
  if (Array.isArray(where)) {
    e += `.where(${where.map((w) => w.expr).join(" and ")})`;
  }
  return fhirpath.compile(e);
}

function compileViewDefinition(viewDefinition) {
  if (viewDefinition.expr) {
    viewDefinition.$expr = compile(viewDefinition.expr);
  }
  if (viewDefinition.from) {
    viewDefinition.$from = compile(viewDefinition.from, viewDefinition.where);
  }
  if (viewDefinition.forEach || viewDefinition.foreach) {
    viewDefinition.$forEach = compile(
      viewDefinition.forEach || viewDefinition.foreach,
      viewDefinition.where
    );
  }

  for (let field of viewDefinition.select || []) {
    compileViewDefinition(field);
  }
}

function cartesianProduct([first, ...rest]) {
  if (rest.length === 0) {
    return first;
  }
  return cartesianProduct(rest).flatMap((r) =>
    first.map((f) => ({ ...f, ...r }))
  );
}

function extractFields(obj, viewDefinition, context = {}) {
  let fields = [];
  for (let field of viewDefinition) {
    let { name, $expr, $forEach, select, $from } = field;
    if (name && $expr) {
      fields.push([{ [name]: $expr(obj, context)[0] }]);
    } else if (($forEach || $from) && select) {
      let nestedObjects = ($forEach || $from)(obj, context);
      if ($from && nestedObjects.length > 1) {
        console.error(
          `Used $from keyword but matched >1 row`,
          field.from,
          nestedObjects
        );
      }
      let rows = [];
      for (let nestedObject of nestedObjects) {
        for (let row of extract(nestedObject, { select }, context)) {
          rows.push(row);
        }
      }
      fields.push(rows);
    } else {
      console.error("Bad expr", viewDefinition);
    }
  }
  return fields;
}

function extract(obj, viewDefinition, context = {}) {
  let fields = extractFields(obj, viewDefinition.select, context);
  return cartesianProduct(fields);
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
