const express = require('express');
const admin = require('firebase-admin');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Inicializar Firebase Admin
const serviceAccount = require('./serviceAccount.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const MessagingResponse = twilio.twiml.MessagingResponse;

app.post('/bot', async (req, res) => {
  const twiml = new MessagingResponse();
  const mensaje = (req.body.Body || '').trim().toLowerCase();

  try {
    let respuesta = '';

    if (mensaje.includes('turno') || mensaje.includes('turnos')) {
      respuesta = await obtenerTurnos();
    } else if (mensaje.includes('medicamento') || mensaje.includes('pastilla') || mensaje.includes('remedio')) {
      respuesta = await obtenerMedicamentos();
    } else if (mensaje.includes('stock')) {
      respuesta = await obtenerStockBajo();
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

app.get('/', (req, res) => res.send('MediDía Bot corriendo ✅'));

async function obtenerTurnos() {
  const snapshot = await db.collection('turnos').get();
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

async function obtenerMedicamentos() {
  const snapshot = await db.collection('medicamentos').get();
  const medicamentos = snapshot.docs.map(doc => doc.data());

  if (medicamentos.length === 0) return '💊 No hay medicamentos cargados.';

  const lista = medicamentos.map(m => {
    const proxima = calcularProximaToma(m.horarioInicio, m.frecuencia);
    return `💊 *${m.nombre}* (${m.formato})\n   ⏰ Próxima toma: ${proxima}`;
  }).join('\n\n');

  return `💊 *Medicamentos:*\n\n${lista}`;
}

async function obtenerStockBajo() {
  const snapshot = await db.collection('medicamentos').get();
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
