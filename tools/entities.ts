#!/usr/bin/env node
// The entity plane's maintenance CLI. Customers, lanes, drivers and carriers
// are knowledge pages (see src/entities.ts for the ruling), so maintaining
// them is editing markdown — this is the tool that does it without anyone
// hand-formatting a page, plus `link`, which prints the exact link entry a
// deliverable should carry.
//
//   node tools/entities.ts list customers
//   node tools/entities.ts show lane DEN-SLC
//   node tools/entities.ts set customer VERDE name="Verde Produce" status=prospect terms="prepay"
//   node tools/entities.ts fact lane DEN-SLC "chains required over Vail Nov-Apr"
//   node tools/entities.ts retire carrier C-BLKM "certificate verified annually"
//   node tools/entities.ts link customer ACME
import { pathToFileURL } from 'node:url';
import {
  ENTITY_KINDS, KNOWLEDGE, entityLink, listEntities, readEntity, upsertEntity,
  type EntityKind,
} from '../src/entities.ts';

const root = process.env.OWP_KNOWLEDGE_DIR ?? KNOWLEDGE;

function kindOf(word: string): EntityKind {
  const singular = word.replace(/s$/, '') as EntityKind;
  if (!ENTITY_KINDS.includes(singular)) {
    throw new Error(`unknown entity kind "${word}" — one of ${ENTITY_KINDS.join(', ')}`);
  }
  return singular;
}

function render(kind: EntityKind, id: string): string {
  const e = readEntity(root, kind, id);
  if (!e) throw new Error(`no ${kind} ${id}`);
  const lines = [`${e.id}  ${e.name}`, `  page: ${e.page}`];
  for (const [k, v] of Object.entries(e.fields)) lines.push(`  ${k}: ${v}`);
  for (const f of e.facts) lines.push(`  · ${f}`);
  return lines.join('\n');
}

export function main(argv: string[]): string {
  const [cmd, kindWord, id, ...rest] = argv;
  switch (cmd) {
    case 'list': {
      const kinds = kindWord && kindWord !== 'all' ? [kindOf(kindWord)] : ENTITY_KINDS;
      return kinds.flatMap(k => {
        const rows = listEntities(root, k);
        return [`${k.toUpperCase()} (${rows.length})`,
          ...rows.map(e => `  ${e.id.padEnd(10)} ${e.name}`)];
      }).join('\n');
    }
    case 'show': return render(kindOf(kindWord), id);
    case 'set': {
      const kind = kindOf(kindWord);
      const fields: Record<string, string> = {};
      let name: string | undefined;
      for (const arg of rest) {
        const m = /^([a-z][a-z0-9_]*)=([\s\S]*)$/.exec(arg);
        if (!m) throw new Error(`expected key=value, got "${arg}"`);
        if (m[1] === 'name') name = m[2]; else fields[m[1]] = m[2];
      }
      upsertEntity(root, { kind, id, name, fields });
      return render(kind, id);
    }
    case 'fact': {
      const kind = kindOf(kindWord);
      upsertEntity(root, { kind, id, facts: [rest.join(' ')] });
      return render(kind, id);
    }
    case 'retire': {
      const kind = kindOf(kindWord);
      // Knowledge is edited in place: a fact that stopped being true leaves the
      // page, and the git diff carries what it replaced (§13.2).
      upsertEntity(root, { kind, id, retire: [rest.join(' ')] });
      return render(kind, id);
    }
    case 'link': return JSON.stringify(entityLink(root, kindOf(kindWord), id), null, 2);
    default:
      return [
        'usage: entities <list|show|set|fact|retire|link> …',
        '  list [customers|lanes|drivers|carriers|all]',
        '  show <kind> <id>',
        '  set <kind> <id> [name="…"] [field=value …]',
        '  fact <kind> <id> "standing fact"',
        '  retire <kind> <id> "standing fact"',
        '  link <kind> <id>',
      ].join('\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
