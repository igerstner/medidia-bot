/**
 * Backfill de familiaresAutorizados
 * =================================
 *
 * Las reglas de Firestore autorizan la lectura cruzada (un familiar viendo los
 * medicamentos, turnos y tomas de un paciente) mirando el array
 * `familiaresAutorizados` del documento `usuarios/{pacienteUid}`.
 *
 * Ese array lo mantiene la app desde VinculoService.js, pero solo desde que se
 * agregó esa lógica. Los vínculos que ya estaban activos antes quedaron sin
 * reflejarse ahí: al deployar las reglas nuevas, esos familiares pierden el
 * acceso aunque su vínculo siga activo.
 *
 * Este script recorre los vínculos activos y reconstruye el array a partir de
 * ellos. Corre con el Admin SDK, que ignora las reglas de seguridad.
 *
 * CUÁNDO CORRERLO
 *   Una sola vez, ANTES de deployar firestore.rules. Correrlo antes es seguro:
 *   agregar el campo no cambia nada mientras las reglas viejas sigan activas.
 *
 * CÓMO CORRERLO (desde la carpeta medidia-bot, en PowerShell)
 *
 *   Simulación, no escribe nada — hacer esto primero y leer la salida:
 *     node scripts/backfill-familiares-autorizados.js
 *
 *   Aplicar los cambios de verdad:
 *     node scripts/backfill-familiares-autorizados.js --aplicar
 *
 * CREDENCIALES
 *   Toma la service account de la variable de entorno FIREBASE_SERVICE_ACCOUNT
 *   (igual que index.js) o, si no está, del archivo local serviceAccount.json.
 *
 * ES IDEMPOTENTE
 *   Usa arrayUnion, así que volver a correrlo no duplica nada ni rompe nada.
 */

const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const APLICAR = process.argv.includes('--aplicar');

function cargarCredenciales() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const ruta = path.join(__dirname, '..', 'serviceAccount.json');
  if (fs.existsSync(ruta)) {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
  }
  throw new Error(
    'No hay credenciales. Definí FIREBASE_SERVICE_ACCOUNT o dejá serviceAccount.json en la raíz de medidia-bot.'
  );
}

async function main() {
  initializeApp({ credential: cert(cargarCredenciales()) });
  const db = getFirestore();

  if (!APLICAR) {
    console.log('MODO SIMULACIÓN — no se escribe nada. Agregá --aplicar para ejecutar los cambios.\n');
  }

  const snap = await db.collection('vinculos').where('estado', '==', 'activo').get();
  console.log(`Vínculos activos encontrados: ${snap.size}\n`);

  if (snap.empty) {
    console.log('No hay nada que hacer.');
    return;
  }

  // Agrupar por paciente para escribir una sola vez por documento, en vez de
  // una escritura por vínculo.
  const porPaciente = new Map();
  for (const doc of snap.docs) {
    const { solicitanteUid, destinatarioUid } = doc.data();
    if (!solicitanteUid || !destinatarioUid) {
      console.warn(`  ⚠ vínculo ${doc.id} incompleto (falta solicitanteUid o destinatarioUid), se saltea`);
      continue;
    }
    if (!porPaciente.has(destinatarioUid)) porPaciente.set(destinatarioUid, new Set());
    porPaciente.get(destinatarioUid).add(solicitanteUid);
  }

  let actualizados = 0;
  let yaEstaban = 0;
  let faltantes = 0;

  for (const [pacienteUid, familiares] of porPaciente) {
    const ref = db.collection('usuarios').doc(pacienteUid);
    const pacienteSnap = await ref.get();

    if (!pacienteSnap.exists) {
      console.warn(`  ⚠ usuarios/${pacienteUid} no existe — vínculo huérfano, se saltea`);
      faltantes++;
      continue;
    }

    const actuales = pacienteSnap.get('familiaresAutorizados') || [];
    const porAgregar = [...familiares].filter((uid) => !actuales.includes(uid));

    if (porAgregar.length === 0) {
      yaEstaban++;
      continue;
    }

    console.log(`  usuarios/${pacienteUid}: agregar ${porAgregar.length} familiar(es) → ${porAgregar.join(', ')}`);

    if (APLICAR) {
      await ref.update({
        familiaresAutorizados: FieldValue.arrayUnion(...porAgregar),
      });
    }
    actualizados++;
  }

  console.log('\n--- Resumen ---');
  console.log(`Pacientes con vínculos activos : ${porPaciente.size}`);
  console.log(`Ya estaban al día              : ${yaEstaban}`);
  console.log(`${APLICAR ? 'Actualizados' : 'A actualizar'}                   : ${actualizados}`);
  if (faltantes > 0) console.log(`Vínculos huérfanos salteados   : ${faltantes}`);

  if (!APLICAR && actualizados > 0) {
    console.log('\nRevisá la lista de arriba y, si está bien, volvé a correrlo con --aplicar.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nFalló el backfill:', error);
    process.exit(1);
  });
