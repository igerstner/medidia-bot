const express = require('express');
const twilio = require('twilio');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Inicializar Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({
  credential: cert(serviceAccount),
});
const db = getFirestore();

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MessagingResponse = twilio.twiml.MessagingResponse;

// Twilio exige formato E.164 con "+" (y el prefijo "whatsapp:") tanto en el
// número de origen como en el de destino. Si a cualquiera de los dos le falta
// algo, Twilio rechaza el mensaje en silencio: no tira error, simplemente no
// llega nada (ya costó una sesión de debug, commit 7bfc58c). normalizarTelefono()
// del lado de la app deja el destino solo con dígitos, así que hay que agregar
// el resto acá antes de mandar.
//
// Se aplica también a TWILIO_WHATSAPP_FROM al cargar la variable de entorno,
// para que quien la configure en Render (con o sin "whatsapp:", con o sin "+")
// no pueda repetir el mismo bug del lado del origen.
function aDestinoWhatsApp(telefono) {
  if (telefono.startsWith('whatsapp:+')) return telefono;
  if (telefono.startsWith('whatsapp:')) return `whatsapp:+${telefono.slice('whatsapp:'.length)}`;
  return `whatsapp:+${telefono.replace(/\D/g, '')}`;
}

const TWILIO_WHATSAPP_FROM = aDestinoWhatsApp(process.env.TWILIO_WHATSAPP_FROM || '14155238886');

app.post('/bot', async (req, res) => {
  const twiml = new MessagingResponse();
  const mensaje = (req.body.Body || '').trim().toLowerCase();
  const fromRaw = req.body.From || '';
  // From llega como "whatsapp:+5493XXXXXXXXX"
  const telefono = fromRaw.replace('whatsapp:', '');

  try {
    const uid = await obtenerUidPorTelefono(telefono);
    let respuesta = '';

    if (!uid) {
      respuesta = '⚠️ No encontré tu cuenta MediDía. Asegurate de estar registrado con este número.';
    } else if (mensaje.includes('turno') || mensaje.includes('turnos')) {
      respuesta = await obtenerTurnos(uid);
    } else if (mensaje.includes('medicamento') || mensaje.includes('pastilla') || mensaje.includes('remedio')) {
      respuesta = await obtenerMedicamentos(uid);
    } else if (mensaje.includes('stock')) {
      respuesta = await obtenerStockBajo(uid);
    } else {
      respuesta = `👋 Hola! Soy el asistente de MediDía.\n\nPodés consultarme:\n• *turnos* → próximos turnos médicos\n• *medicamentos* → medicamentos del día\n• *stock* → medicamentos con stock bajo`;
    }

    twiml.message(respuesta);
  } catch (error) {
    console.error(error);
    twiml.message('Hubo un error al consultar la información. Intentá de nuevo.');
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

// El código en sí nunca se devuelve al cliente ni se compara del lado de la app:
// si el que verifica (el solicitante) pudiera leer 'codigos_verificacion' directo,
// no haría falta que el destinatario se lo confirme por WhatsApp. Por eso la
// comparación vive acá, con Admin SDK, y la app solo recibe true/false.
async function validarYConsumirCodigoVinculo(uid, codigoIngresado) {
  const ahora = new Date();
  const snapshot = await db.collection('codigos_verificacion')
    .where('uid', '==', uid)
    .where('usado', '==', false)
    .get();

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const expira = data.expiresAt?.toDate ? data.expiresAt.toDate() : data.expiresAt;
    if (!expira || expira < ahora) continue;
    if ((data.intentos || 0) >= 5) continue; // demasiados intentos fallidos, código invalidado
    if (data.codigo === codigoIngresado) {
      await docSnap.ref.update({ usado: true });
      return true;
    }
    await docSnap.ref.update({ intentos: (data.intentos || 0) + 1 });
  }
  return false;
}

app.post('/verificar-codigo-vinculo', async (req, res) => {
  const { uid, codigo } = req.body;
  if (!uid || !codigo) {
    return res.status(400).json({ ok: false, error: 'Parámetros faltantes' });
  }
  try {
    const valido = await validarYConsumirCodigoVinculo(uid, codigo);
    res.json({ ok: valido });
  } catch (error) {
    console.error('Error en /verificar-codigo-vinculo:', error);
    res.status(500).json({ ok: false, error: 'No se pudo verificar el código' });
  }
});

app.post('/enviar-codigo', async (req, res) => {
  const { telefono, codigo, nombreSolicitante } = req.body;
  if (!telefono || !codigo || !nombreSolicitante) {
    return res.status(400).json({ ok: false, error: 'Parámetros faltantes' });
  }
  try {
    const destino = aDestinoWhatsApp(telefono);
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: destino,
      body:
        `🔐 Tu código de verificación MediDía es: ${codigo}\n` +
        `${nombreSolicitante} quiere vincularse con vos.\n` +
        `Este código expira en 10 minutos.`,
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error enviando código:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Reset de contraseña por WhatsApp
// -----------------------------------------------------------------------------
// Rate limit en memoria: alcanza para una sola instancia de Render. Si algún día
// se escala a más de una instancia, reemplazar por un contador en Firestore.
const intentosResetPorTelefono = new Map();
const LIMITE_SOLICITUDES_RESET = 3;
const VENTANA_RESET_MS = 15 * 60 * 1000;

function puedeSolicitarReset(telefono) {
  const ahora = Date.now();
  const registro = intentosResetPorTelefono.get(telefono);
  if (!registro || ahora > registro.expiraEn) {
    intentosResetPorTelefono.set(telefono, { conteo: 1, expiraEn: ahora + VENTANA_RESET_MS });
    return true;
  }
  if (registro.conteo >= LIMITE_SOLICITUDES_RESET) return false;
  registro.conteo += 1;
  return true;
}

app.post('/solicitar-reset', async (req, res) => {
  const { telefono } = req.body;
  if (!telefono) {
    return res.status(400).json({ ok: false, error: 'Falta el teléfono' });
  }
  // Responde 'ok' siempre exista o no la cuenta, para no filtrar qué números están registrados.
  try {
    if (puedeSolicitarReset(telefono)) {
      const uid = await obtenerUidPorTelefono(telefono);
      if (uid) {
        const codigo = generarCodigoReset();
        await guardarCodigoReset(uid, codigo);
        const destino = aDestinoWhatsApp(telefono);
        await twilioClient.messages.create({
          from: TWILIO_WHATSAPP_FROM,
          to: destino,
          body:
            `🔐 Tu código para restablecer tu contraseña de MediDía es: ${codigo}\n` +
            `Expira en 10 minutos. Si no lo pediste vos, ignorá este mensaje.`,
        });
      }
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Error en /solicitar-reset:', error);
    res.json({ ok: true }); // no filtramos info interna aunque falle algo
  }
});

app.post('/confirmar-reset', async (req, res) => {
  const { telefono, codigo, nuevaContrasena } = req.body;
  if (!telefono || !codigo || !nuevaContrasena) {
    return res.status(400).json({ ok: false, error: 'Parámetros faltantes' });
  }
  if (nuevaContrasena.length < 6) {
    return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  try {
    const uid = await obtenerUidPorTelefono(telefono);
    if (!uid) {
      return res.status(400).json({ ok: false, error: 'Código incorrecto o expirado' });
    }
    const valido = await validarYConsumirCodigoReset(uid, codigo);
    if (!valido) {
      return res.status(400).json({ ok: false, error: 'Código incorrecto o expirado' });
    }
    await getAuth().updateUser(uid, { password: nuevaContrasena });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error en /confirmar-reset:', error);
    res.status(500).json({ ok: false, error: 'No se pudo restablecer la contraseña' });
  }
});

app.get('/', (req, res) => res.send('MediDía Bot corriendo ✅'));

async function obtenerUidPorTelefono(telefono) {
  if (!telefono) return null;
  const snapshot = await db.collection('usuarios').where('telefono', '==', telefono).get();
  if (snapshot.empty) return null;
  return snapshot.docs[0].id;
}

function generarCodigoReset() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Antes de crear el código nuevo, invalida los anteriores sin usar de ese uid.
// Sin esto, pedir el código varias veces (típico en debugging, o si el primer
// WhatsApp tarda) deja varios códigos válidos al mismo tiempo, y es fácil
// terminar tipeando uno viejo que ya venció mientras el más nuevo seguía activo.
async function guardarCodigoReset(uid, codigo) {
  const ahora = new Date();
  const expiraEn = new Date(ahora.getTime() + 10 * 60 * 1000);

  const anteriores = await db.collection('codigos_reset_password')
    .where('uid', '==', uid)
    .where('usado', '==', false)
    .get();
  await Promise.all(anteriores.docs.map(d => d.ref.update({ usado: true })));

  await db.collection('codigos_reset_password').add({
    uid,
    codigo,
    creadoEn: ahora,
    expiraEn,
    usado: false,
    intentos: 0,
  });
}

// Colección separada de 'codigos_verificacion' (vinculación familiar) a propósito:
// distinto dominio de seguridad, y este solo lo lee/escribe el bot con Admin SDK.
async function validarYConsumirCodigoReset(uid, codigoIngresado) {
  const ahora = new Date();
  const snapshot = await db.collection('codigos_reset_password')
    .where('uid', '==', uid)
    .where('usado', '==', false)
    .get();

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    if (data.expiraEn.toDate() < ahora) continue;
    if ((data.intentos || 0) >= 5) continue; // demasiados intentos fallidos, código invalidado
    if (data.codigo === codigoIngresado) {
      await docSnap.ref.update({ usado: true });
      return true;
    }
    await docSnap.ref.update({ intentos: (data.intentos || 0) + 1 });
  }
  return false;
}

async function obtenerTurnos(userId) {
  const snapshot = await db.collection('turnos').where('userId', '==', userId).get();
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const proximos = snapshot.docs
    .map(doc => doc.data())
    .filter(t => {
      const fecha = parsearFecha(t.fecha);
      return fecha && fecha >= hoy;
    })
    .sort((a, b) => parsearFecha(a.fecha) - parsearFecha(b.fecha))
    .slice(0, 3);

  if (proximos.length === 0) return '📅 No hay turnos próximos agendados.';

  const lista = proximos.map(t =>
    `📅 ${t.especialidad} - ${t.fecha} a las ${t.hora}hs${t.medico ? `\n   👨‍⚕️ ${t.medico}` : ''}${t.lugar ? `\n   📍 ${t.lugar}` : ''}`
  ).join('\n\n');

  return `🏥 *Próximos turnos:*\n\n${lista}`;
}

async function obtenerMedicamentos(userId) {
  const snapshot = await db.collection('medicamentos').where('userId', '==', userId).get();
  const medicamentos = snapshot.docs.map(doc => doc.data());

  if (medicamentos.length === 0) return '💊 No hay medicamentos cargados.';

  const lista = medicamentos.map(m => {
    const proxima = calcularProximaToma(m.horarioInicio, m.frecuencia);
    return `💊 *${m.nombre}* (${m.formato})\n   ⏰ Próxima toma: ${proxima}`;
  }).join('\n\n');

  return `💊 *Medicamentos:*\n\n${lista}`;
}

async function obtenerStockBajo(userId) {
  const snapshot = await db.collection('medicamentos').where('userId', '==', userId).get();
  const bajos = snapshot.docs
    .map(doc => doc.data())
    .filter(m => m.stockActual !== null && m.stockActual <= m.stockEnvase * 0.2);

  if (bajos.length === 0) return '✅ Todos los medicamentos tienen stock suficiente.';

  const lista = bajos.map(m =>
    `⚠️ *${m.nombre}*: quedan ${m.stockActual} ${m.unidad}`
  ).join('\n');

  return `📦 *Stock bajo:*\n\n${lista}`;
}

function parsearFecha(fechaStr) {
  if (!fechaStr || !/^\d{2}\/\d{2}\/\d{4}$/.test(fechaStr)) return null;
  const [dia, mes, anio] = fechaStr.split('/').map(Number);
  return new Date(anio, mes - 1, dia);
}

function calcularProximaToma(horarioInicio, frecuencia) {
  if (!horarioInicio || !frecuencia) return 'Sin datos';
  const match = frecuencia.match(/\d+/);
  if (!match) return 'Sin datos';
  const intervaloHoras = parseInt(match[0]);
  const [horas, minutos] = horarioInicio.split(':').map(Number);
  const ahora = new Date();
  const inicio = new Date();
  inicio.setHours(horas, minutos, 0, 0);
  let proxima = new Date(inicio);
  while (proxima <= ahora) {
    proxima = new Date(proxima.getTime() + intervaloHoras * 60 * 60 * 1000);
  }
  const horaStr = proxima.getHours().toString().padStart(2, '0');
  const minStr = proxima.getMinutes().toString().padStart(2, '0');
  const esHoy = proxima.toDateString() === ahora.toDateString();
  return esHoy ? `Hoy ${horaStr}:${minStr}` : `Mañana ${horaStr}:${minStr}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
