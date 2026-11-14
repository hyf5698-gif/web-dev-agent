export function parseOptions(args, { values = [], flags = [], positionals = false } = {}) {
  const result = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flags.includes(arg)) {
      if (result[arg]) throw new Error(`Repeated option: ${arg}`);
      result[arg] = true;
    } else if (values.includes(arg)) {
      if (Object.hasOwn(result, arg)) throw new Error(`Repeated option: ${arg}`);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result[arg] = value;
    } else if (positionals && !arg.startsWith('--')) result._.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

export function loopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('URL must be an absolute loopback HTTP URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password) {
    throw new Error('Only loopback HTTP(S) URLs without credentials are accepted.');
  }
  return url;
}
