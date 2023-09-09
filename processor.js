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
    if (resource.resourceType === config.resource) {
      yield* extract(resource, config, context);
    }
  }
}

export function getColumns(viewDefinition) {
  return (viewDefinition.select || []).flatMap((c) => {
    if (c.path) {
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
    e += `.where(${where.join(" and ")})`;
  }
  return fhirpath.compile(e);
}

function compileViewDefinition(viewDefinition) {
  if (viewDefinition.path) {
    viewDefinition.$path = compile(viewDefinition.path);
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
    let { name, alias, path, $path, $forEach, select, $from } = field;
    name = name ?? alias ?? path.split(".").slice(-1)[0];
    if (name && $path) {
      fields.push([{ [name]: $path(obj, context)[0] }]);
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
      console.error("Bad path", viewDefinition);
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


export async function runTests(source) {
  const results = JSON.parse(JSON.stringify(source))
  results.implementation = "https://github.com/jmandel/fhir-view-to-array";
    for (const t of results.tests) {
      const resources = async function*(){
        for (const r of results.resources) {
          yield r;
        }
      }
      const processor = processResources(resources(), t.view);
      const rows = [];
      for await (const row of processor) {
        rows.push(row)
      }
      const result = arraysMatch(rows, t.expect);
      t.result = result.passed ? {...result, message: undefined} : result;
    }
    return JSON.parse(JSON.stringify(results));
}

function arraysMatch(arr1, arr2) {
    // Check if arrays are of the same length
    if (arr1.length !== arr2.length) {
        return {
            passed: false,
            message: `Array lengths do not match. Expected ${arr2.length} but got ${arr1.length}.`
        };
    }

    // Check each pair of objects
    for (let i = 0; i < arr1.length; i++) {
        const obj1 = arr1[i];
        const obj2 = arr2[i];

        // Get keys of both objects
        const keys1 = Object.keys(obj1);
        const keys2 = Object.keys(obj2);

        // Check if both objects have the same number of keys
        if (keys1.length !== keys2.length) {
            return {
                passed: false,
                message: `Objects at index ${i} have different number of keys.`
            };
        }

        // Check if keys and values match for both objects
        for (const key of keys1) {
            if (obj1[key] !== obj2[key]) {
                return {
                    passed: false,
                    message: `Mismatch at index ${i} for key "${key}". Expected "${obj2[key]}" but got "${obj1[key]}".`
                };
            }
        }
    }

    // If all checks passed, arrays match
    return {
        passed: true,
        message: 'Arrays match successfully.'
    };
}