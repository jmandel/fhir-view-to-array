if (!window.fhirpath) {
  await import("./vendor/fhirpath.js");
}

export async function* processResources(resourceGenerator, configIn) {
  const config = JSON.parse(JSON.stringify(configIn));
  console.log("Run test", configIn);
  const context = (config.constants || []).reduce((acc, next) => {
    acc[next.name] = next.value;
    return acc;
  }, {});
  compileViewDefinition(config);
  for await (const resource of resourceGenerator) {
    console.log("DEF", getColumns(config))
    if ((config?.$resource || ((r) => r))(resource).length) {
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
  const ofTypeRegex = /\.ofType\(([^)]+)\)/;
  const match = e.match(ofTypeRegex);
  if (match) {
      const replacement = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      e = e.replace(ofTypeRegex, `${replacement}`);
      console.log("\n\n***RE", e)
  }

  if (Array.isArray(where)) {
    e += `.where(${where.map(w => w.path).join(" and ")})`;
  }
  return fhirpath.compile(e);
}

function compileViewDefinition(viewDefinition) {
  if(viewDefinition.path && !viewDefinition.alias) {
    viewDefinition.alias = viewDefinition.name ?? viewDefinition.path.split(".").filter(p => !p.includes("(")).slice(-1)[0]
  }
  if (viewDefinition.path) {
    viewDefinition.$path = compile(viewDefinition.path);
  }
  if (viewDefinition.from) {
    viewDefinition.$from = compile(viewDefinition.from, viewDefinition.where);
  }
  if (viewDefinition.forEach) {
    viewDefinition.$forEach = compile(
      viewDefinition.forEach,
      viewDefinition.where
    );
  }
  if (viewDefinition.forEachOrNull) {
    viewDefinition.$forEachOrNull = compile(
      viewDefinition.forEachOrNull,
      viewDefinition.where
    );
  }
  if (viewDefinition.resource) {
    viewDefinition.$resource = compile(viewDefinition.resource, viewDefinition.where)
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
    let { name, alias, path, $path, $forEach, $forEachOrNull, select, $from } = field;
    alias = alias ?? name
    if (alias && $path) {
      const result = $path(obj, context);
      if (result.length) {
        fields.push([{ [alias]:  result[0]}]);
      } else {
        fields.push([]);
      }
    } else if (($forEach || $forEachOrNull || $from) && select) {
      let nestedObjects = ($forEach || $forEachOrNull || $from)(obj, context);
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
      if ($forEachOrNull && nestedObjects.length === 0) {
        const nulls = {}
        getColumns(field).forEach(c => nulls[c.alias] = null)
        rows.push(nulls)
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
      try {

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
      if (!t.result.passed) {
        t.unexpected = rows;
      }
      } catch(error) {
        t.result = {
          passed: false,
          error
        }
      }
    }
    return JSON.parse(JSON.stringify(results));
}

function arraysMatch(arr1, arr2) {
    // Canonicalize arrays
    const canonicalize = (arr) => {
        return arr.sort((a, b) => {
            const keysA = Object.keys(a).sort();
            const keysB = Object.keys(b).sort();
            
            for (let i = 0; i < Math.min(keysA.length, keysB.length); i++) {
                if (a[keysA[i]] < b[keysB[i]]) return -1;
                if (a[keysA[i]] > b[keysB[i]]) return 1;
            }

            return keysA.length - keysB.length; // if one has more keys than the other
        });
    };

    arr1 = canonicalize([...arr1]); // Spread to avoid mutating the original array
    arr2 = canonicalize([...arr2]);

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
