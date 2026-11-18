// validate.mjs — 极简 JSON Schema 校验器（零依赖）。
//
// 只支持这些 keyword：type / required / properties / additionalProperties /
// items / enum / minItems / maxItems / minLength / maxLength / oneOf / $ref。
// 够用来校验 groups.json 与 insights.json —— 目的不是做通用实现，
// 而是让"字段写错"变成精确报错，而不是静默失效。
//
// 返回 { errors: [{ path, message }] }，path 用 JSON Pointer 风格（/layers/0/role）。

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(value, t) {
  const actual = typeOf(value);
  if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (t === 'object') return actual === 'object';
  return actual === t;
}

const TYPE_CN = {
  string: '字符串', number: '数字', integer: '整数', boolean: '布尔值',
  object: '对象', array: '数组', null: 'null',
};

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return null;
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node || null;
}

const join = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function check(value, schema, root, path, errors, depth) {
  if (!schema || depth > 40) return;

  if (schema.$ref) {
    const target = resolveRef(root, schema.$ref);
    check(value, target, root, path, errors, depth + 1);
    return;
  }

  // oneOf：任意一个分支通过就算通过；全不通过时给出简短的合并说明
  if (Array.isArray(schema.oneOf)) {
    for (const branch of schema.oneOf) {
      const sub = [];
      check(value, branch, root, path, sub, depth + 1);
      if (sub.length === 0) return;
    }
    errors.push({ path, message: '不符合任何一种允许的结构（oneOf）' });
    return;
  }

  if (Array.isArray(schema.type)) {
    if (!schema.type.some((t) => matchesType(value, t))) {
      errors.push({ path, message: `类型应为 ${schema.type.map((t) => TYPE_CN[t] || t).join(' 或 ')}，实际是 ${TYPE_CN[typeOf(value)] || typeOf(value)}` });
      return;
    }
  } else if (schema.type) {
    if (!matchesType(value, schema.type)) {
      errors.push({ path, message: `类型应为 ${TYPE_CN[schema.type] || schema.type}，实际是 ${TYPE_CN[typeOf(value)] || typeOf(value)}` });
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({ path, message: `取值必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' / ')} 之一` });
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push({ path, message: `至少 ${schema.minLength} 个字符（当前 ${value.length}）` });
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push({ path, message: `最多 ${schema.maxLength} 个字符（当前 ${value.length}）` });
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push({ path, message: `至少需要 ${schema.minItems} 项（当前 ${value.length}）` });
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push({ path, message: `最多 ${schema.maxItems} 项（当前 ${value.length}）` });
    }
    if (schema.items) value.forEach((v, i) => check(v, schema.items, root, join(path, i), errors, depth + 1));
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push({ path: join(path, key), message: '必填字段缺失' });
    }
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) check(v, props[key], root, join(path, key), errors, depth + 1);
      else if (schema.additionalProperties === false) {
        errors.push({ path: join(path, key), message: '未知字段（拼错了？或不该出现在这里）' });
      }
    }
  }
}

/**
 * @param {any} data 被校验的数据
 * @param {object} schema JSON Schema（会被当作 $ref 的根）
 * @returns {{errors: Array<{path: string, message: string}>}}
 */
export function validate(data, schema) {
  const errors = [];
  check(data, schema, schema, '', errors, 0);
  return { errors: errors.map((e) => ({ path: e.path || '/', message: e.message })) };
}

export default validate;
