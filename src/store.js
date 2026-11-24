import fs from 'node:fs';
import path from 'node:path';

/**
 * Store simples em arquivo JSON com escrita atômica (tmp + rename).
 *
 * O volume é baixíssimo: 1 sessão por vez, alguns pedidos por dia. Um banco
 * relacional não se paga aqui. Toda mutação passa por `mutate`, que grava
 * antes de retornar — assim um crash nunca deixa o estado "meio aplicado"
 * em memória apenas.
 */
export function createStore(file, initial) {
  const full = path.resolve(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  let data = initial();
  if (fs.existsSync(full)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      data = { ...data, ...parsed };
    } catch (err) {
      const backup = `${full}.corrupt-${Date.now()}`;
      fs.copyFileSync(full, backup);
      console.error(`[store] JSON inválido, backup em ${backup}:`, err.message);
    }
  }

  function save() {
    const tmp = `${full}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, full);
  }

  save();

  return {
    get data() {
      return data;
    },
    /** Aplica uma mutação e persiste. Retorna o que a função retornar. */
    mutate(fn) {
      const result = fn(data);
      save();
      return result;
    },
    save,
    file: full,
  };
}
