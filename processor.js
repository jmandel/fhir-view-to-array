import fhirpath from "https://cdn.skypack.dev/fhirpath";

export async function* processResources(resourceGenerator, configIn) {
  const config = JSON.parse(JSON.stringify(configIn));
  const context = vars(configIn.context);
  config.expand = [...context, ...(config.expand || []).map(c => ({...c, expr: useVars(configIn.context, c.expr)}))]
  config.columns = config.columns.map(c => ({...c, expr: useVars(configIn.context, c.expr)}));
  ["expand", "vars", "filters", "columns"].forEach((s) => {
    config[s] && config[s].forEach((r) => {
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

  function* iterateVariables(collectionVars, context = {resource}) {
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

class Tokenizer {
  constructor(input) {
    this.input = input;
    this.index = 0;
  }

  hasMore() {
    return this.index < this.input.length;
  }

  next() {
    return this.input[this.index++];
  }

  peek() {
    return this.input[this.index];
  }
}

function isIdentifierStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentifierPart(ch) {
  return isIdentifierStart(ch) || (ch >= '0' && ch <= '9');
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

export default function parse(input) {
  let parser = new Parser(input || "");
  return parser.parse();
}

class Parser {
  constructor(input) {
    this.tokenizer = new Tokenizer(input);
  }

  parse() {
    return this.parseExpression();
  }

  parseExpression() {
    return this.parseBinaryExpression();
  }

  parseBinaryExpression(minPrecedence) {
    let left = this.parsePrimaryExpression();

    while (this.tokenizer.hasMore()) {
      let ch = this.tokenizer.peek();
      let precedence = this.getOperatorPrecedence(ch);

      if (precedence === null || precedence <= minPrecedence) {
        break;
      }

      this.tokenizer.next(); // Consume the operator.

      let right = this.parseBinaryExpression(precedence);
      left = { type: 'binary', operator: ch, left, right };
    }

    return left;
  }

  getOperatorPrecedence(operator) {
    switch (operator) {
      case '=':
        return 0;
      case '+':
      case '-':
        return 1;
      case '*':
      case '/':
        return 2;
      default:
        return null;
    }
  }

  parsePrimaryExpression() {
    let items = [];

    while (this.tokenizer.hasMore()) {
    let ch = this.tokenizer.peek();
    if (isWhitespace(ch)) {
      this.tokenizer.next();
    } else if (ch === "'") {
      items.push(this.parseConstant());
    } else if (ch === ".") {
      this.tokenizer.next();
      items.push(this.parseNavigationOrInvocation());
    } else if (isIdentifierStart(ch)) {
      items.push(this.parseNavigationOrInvocation());
    } else if (ch === '(') {
      this.tokenizer.next(); // Consume opening parenthesis.
      let expr = this.parseExpression();

      if (this.tokenizer.peek() !== ')') {
        throw new Error("Expected closing parenthesis");
      }

      this.tokenizer.next(); // Consume closing parenthesis.
      items.push(expr);
    } else {
      break;
    }

    }
    return items;
  }

  parseConstant() {
    let value = '';

    this.tokenizer.next(); // Skip opening quote.

    while (this.tokenizer.hasMore()) {
      let ch = this.tokenizer.next();

      if (ch === "'") {
        return { type: 'constant', value };
      }

      value += ch;
    }

    throw new Error("Unterminated constant");
  }

  parseNavigationOrInvocation() {
    let isVar = this.tokenizer.peek() === '%';
    if (isVar) {
      this.tokenizer.next();
    }
    let name = this.parseIdentifier();
    let args = null;

    if (this.tokenizer.peek() === '(') {
      args = this.parseArguments();
    }

    return args ? { type: 'invocation', name, args } : { type: isVar ? 'variable' : 'navigation', name };
  }

  parseIdentifier() {
    let id = '';

    while (this.tokenizer.hasMore()) {
      let ch = this.tokenizer.peek();

      if (isIdentifierPart(ch)) {
        id += this.tokenizer.next();
      } else {
        break;
      }
    }

    return id;
  }

  parseArguments() {
    let args = [];

    this.tokenizer.next(); // Skip opening parenthesis.

    while (this.tokenizer.hasMore()) {
      let ch = this.tokenizer.peek();

      if (ch === ')') {
        this.tokenizer.next();
        return args;
      }


      const arg = this.parseExpression()
      args.push(arg);

      ch = this.tokenizer.peek();

      if (ch === ',') {
        this.tokenizer.next(); // Skip comma.
      } else if (ch !== ')') {
        throw new Error(`Unexpected character in arguments: ${ch}`);
      }
    }

    throw new Error("Unterminated arguments");
  }

}

function renderExpression(exp) {
  return exp.reduce((acc, s, idx) => {
    return acc + (idx > 0 ? "." : "") + renderSegment(s)
  }, "")
}

function renderSegment(s) {
  const {type, name, operator, left, right, args, value} = s;
  if (type === "navigation" || type === "variable") {
    return name;
  } else if (type === "invocation") {
    return `${name}(${args.map(renderSegment).join(", ")})`;
  } else if (type === "binary") {
    return `${renderExpression(left)}${operator}${renderExpression(right)}`
  } else if (type === "constant") {
    return `'${value}'`
  } else {
    return renderExpression(s)
  }
}

function extractVars(input) {
  const parsed = parse(input);
  const reduced = parsed.reduce((acc, segment, idx) => {
    if (segment.type === "navigation") {
      acc.push({
        element: segment.name,
        segments: segment.name
      })
    } else if (segment.type === 'invocation') {
      acc[acc.length-1].segments += "." + renderSegment(segment)
    }
    return acc;
  }, [])
  return reduced;

}

const commonPrefix = (contextExpr, candidateExpr) => {
  const contextParse = extractVars(contextExpr);
  const candidateParse = extractVars(candidateExpr);
  let ret = 0;
  for (let i=0; i<Math.min(contextParse.length, candidateParse.length) ; i++) {
    if (candidateParse[i].element === contextParse[i].element) {
      ret += 1
    } else { break; }
  }

  return ret;
}

export const vars = (expr) => {
  const extracted = extractVars(expr);
  return extracted.map((v, i) => ({
    name: String.fromCharCode(97+i),
    expr: (i>0 ? `%${String.fromCharCode(97+i-1)}.`: "") + v.segments
  })).concat({name: "context", expr: `%${String.fromCharCode(97+extracted.length-1)}`})
}

export const useVars = (contextExpr, candidateExpr) => {
  const candidateSegments = parse(candidateExpr).length;
  const n = commonPrefix(contextExpr, candidateExpr);
  if (n == 0) {
    return candidateExpr
  }
  return `%${String.fromCharCode(97+n-1)}${n < candidateSegments ? "." : ""}` + renderExpression(parse(candidateExpr).slice(n))
}

// console.log("P",JSON.stringify(parse("Patient.telecom.where(system ='b')"), null, 2))
// console.log("P", renderExpression(parse("Patient.telecom.where(system ='b')")))
// fhirpath.compile("Patient.identifier.exists(this.use = 'official')");