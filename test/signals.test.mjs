/**
 * The markers catch_up orders by: a fixed set of short Romanian and English
 * messages, the way people write them (diacritics or not, homographs
 * included), each labelled with the markers a reader would put on it. Every
 * marker must keep the precision and recall below; the set is where a new
 * guard or a new word is proven, and a message the detector gets wrong on
 * purpose stays in it labelled as a reader would, not as the detector does.
 *
 * Thresholds (per marker, over this set):
 * - precision ≥ 0.95 for every marker: a wrong marker reorders a summary for nothing;
 * - recall ≥ 0.90 for link, amount, date, time and address, ≥ 0.80 for
 *   question: a Romanian yes/no question without "?" that opens with its verb
 *   ("Vii și tu diseară") is left unmarked on purpose, since as many sentences
 *   that open the same way are statements ("Ești acasă", "Rămâne cum am vorbit").
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SIGNALS, signalsOf } from "../dist/signals.js";

/** [message, the markers a reader puts on it] */
const CASES = [
  // amount
  ["Plătește 150 lei până vineri", "amount date"],
  ["Costă 20 de euro de persoană", "amount"],
  ["Ți-am trimis 350 RON pe Revolut", "amount"],
  ["Factura e 1.250,50 lei", "amount"],
  ["am dat 50€ la benzinărie", "amount"],
  ["It's $45 for both tickets", "amount"],
  ["Rent is 900 this month", "amount"],
  ["Chiria e 400, o dau mâine", "amount date"],
  ["IBAN: RO49 AAAA 1B31 0075 9384 0000", "amount"],
  ["Poți să-mi faci transfer în RO49AAAA1B31007593840000?", "amount question"],
  ["total 1200 cu tot cu transport", "amount"],
  ["Mai am de dat 2 mii de lei la bancă", "amount"],
  ["£20 each, cash please", "amount"],
  ["e 5k eur avansul", "amount"],
  ["am platit 75 lei la curier", "amount"],
  ["You owe me 30 bucks", "amount"],
  ["RON 150 per oră", "amount"],
  ["prețul e 99,99 lei", "amount"],
  ["Plata la livrare, 89,90 lei", "amount"],
  ["Transfer 500 eur to my account", "amount"],
  ["[image] factura 350 lei", "amount"],
  ["Apartament 2 camere, etaj 3, 65.000 euro", "amount"],
  ["E prea scump, 3000 e mult", "amount"],
  ["Avans 30%, restul la livrare", ""],
  ["Suntem 5 persoane la masă", ""],
  ["am 3 copii și 2 câini", ""],
  ["comanda nr. 12345 a plecat", ""],
  ["Stau la etajul 4", ""],
  ["Am alergat 10 km azi", "date"],
  ["Ai 2 minute?", "question"],
  ["Total am fost 12 oameni", ""],
  ["Fac 30 de ani luna viitoare", "date"],
  ["Codul e 4821", ""],
  ["Scorul a fost 3-1", ""],
  ["Asta costă cât o mașină", ""],
  ["Chiria pe 3 luni", ""],

  // date
  ["Ne vedem pe 15.09", "date"],
  ["Termenul e 30/09/2026", "date"],
  ["Nunta e pe 12 iunie", "date"],
  ["Plecăm în august, pe 5 august mai exact", "date"],
  ["Întâlnirea e joi", "date"],
  ["Vii luni la birou?", "date question"],
  ["Mâine nu pot", "date"],
  ["Poimaine sunt liber", "date"],
  ["Ieri am uitat să te sun", "date"],
  ["See you on Friday", "date"],
  ["Meeting moved to 2026-10-03", "date"],
  ["Are you free tomorrow?", "date question"],
  ["Sâmbătă mergem la munte", "date"],
  ["Pe 1 mai facem grătar", "date"],
  ["Duminica asta vine mama", "date"],
  ["Deadline is May 5th", "date"],
  ["My birthday is on 3 March", "date"],
  ["Recepția e în septembrie", "date"],
  ["Pleacă de luni", "date"],
  ["Pe 3 mai e ziua lui", "date"],
  ["Weekendul ăsta mergem la mare", "date"],
  ["The package arrives next week", "date"],
  ["Rezervarea e pe booking.com pentru 12-14 octombrie", "link date"],
  ["Mai vreau o cafea", ""],
  ["Nu mai pot", ""],
  ["Am stat 3 luni în Spania", ""],
  ["De luni de zile aștept", ""],
  ["May I come in?", "question"],
  ["Scor final 2.1 pentru noi", ""],
  ["Am luat nota 9.50 la examen", ""],
  ["Ceva mai bun de atât nu găsești", ""],
  ["Martinez a marcat", ""],
  ["I march every year", ""],
  ["Luni întregi n-am vorbit", ""],
  ["Am muncit ultimele luni la proiect", ""],
  ["Suntem 4 mai mulți decât anul trecut", ""],
  ["Mai trimite o poză", ""],
  ["Joaca e la 4 pe terenul din spate", "time"],

  // time
  ["Ajung la 6", "time"],
  ["Ne vedem la 10:30", "time"],
  ["Programarea e la ora 14", "time"],
  ["Ora 7 la poartă", "time"],
  ["Call at 3pm", "time"],
  ["Pe la 9 sunt acasă", "time"],
  ["Let's meet around 11", "time"],
  ["Filmul începe la 20.30", "time"],
  ["Vin între 18 și 19", "time"],
  ["Mâncăm la prânz", "time"],
  ["Trenul pleacă 7:45", "time"],
  ["Ne vedem la 7 seara", "time"],
  ["I'll be there by 6", "time"],
  ["Diseară la 8 la mine", "date time"],
  ["Programare dentist 23.09 ora 11:15", "date time"],
  ["Ședința de joi se mută vineri la 12", "date time"],
  ["Is it ok if I come at 8", "question time"],
  ["Sunt la 10 minute de tine", ""],
  ["Casa e la 2 km de sat", ""],
  ["Am ajuns la 50 de mesaje necitite", ""],
  ["Le-am dat la 3 oameni", ""],
  ["Ora de mers e lungă", ""],
  ["Am luat 10 la test", ""],
  ["Reducere de la 5 lei", "amount"],
  ["Suntem la 1 pas de final", ""],
  ["Grupa de la 8 ani", ""],
  ["Sunt 2 ore de condus", ""],
  ["Vin în 10 minute", ""],
  ["Te sun înapoi în 5", ""],
  ["La mulți ani!", ""],

  // address
  ["Adresa e Str. Mihai Eminescu nr. 12", "address"],
  ["Vino pe Calea Victoriei 45", "address"],
  ["Vino pe Calea Victoriei cu un ca\u0302ine", "address"],
  ["Bl. A3, sc. 2, ap. 14", "address"],
  ["Stau pe Bulevardul Unirii, lângă metrou", "address"],
  ["Livrare: Strada Florilor 7, Cluj", "address"],
  ["Piața Unirii la 5?", "address time question"],
  ["221B Baker Street, London", "address"],
  ["My address is 42 Park Avenue", "address"],
  ["Aleea Teiului bl 5 ap 20", "address"],
  ["Intrarea din Șos. Kiseleff", "address"],
  ["Mergem la piață după", ""],
  ["Calea cea mai scurtă e prin parc", ""],
  ["Comanda nr. 5 a sosit", ""],
  ["Etajul 3 are aer condiționat", ""],
  ["Pe strada noastră e liniște", ""],
  ["Am terminat etapa 2", ""],

  // link
  ["uite aici https://maps.app.goo.gl/abc123", "link"],
  ["www.emag.ro are reducere", "link"],
  ["Intră pe olx.ro și caută", "link"],
  ["Check github.com/razvan/wazap", "link"],
  ["wa.me/40700000000", "link"],
  ["Formular: https://forms.gle/xyz?id=15.09", "link"],
  ["Vezi https://youtu.be/dQw4w9WgXcQ", "link"],
  ["Link: meet.google.com/abc-defg-hij", "link"],
  ["Programează-te pe calendly.com/dr-popescu", "link"],
  ["Scrie-mi pe ana@firma.ro", ""],
  ["Am terminat.Mergem acasa", ""],
  ["Ok.bine", ""],

  // question
  ["Ce faci?", "question"],
  ["ce faci", "question"],
  ["Când ajungi", "question"],
  ["Unde ești", "question"],
  ["Poți să mă suni", "question"],
  ["Vii și tu diseară", "date question"],
  ["How are you doing", "question"],
  ["Can you send me the file", "question"],
  ["Where is the meeting", "question"],
  ["Ai timp azi pentru o cafea", "date question"],
  ["Cine vine la meci", "question"],
  ["What time works for you", "question"],
  ["Oare mai are rost", "question"],
  ["Știi cumva numărul lui Dan", "question"],
  ["Rămâne pe mâine?", "date question"],
  ["Ce bine că ai ajuns", ""],
  ["Când am ajuns acasă am dormit", ""],
  ["Cum am zis, vin mai târziu", ""],
  ["What a day", ""],
  ["How nice of you", ""],
  ["Mulțumesc frumos", ""],
  ["Ai grijă de tine", ""],
  ["Cine a mâncat tot", ""],
  ["Unde am pus cheile, nu știu", ""],

  // everyday and mixed
  ["Bună! Mâine la 9 la Str. Lalelor 3, ok?", "date time address question"],
  ["Trimite 200 lei pe IBAN RO12BTRL0000000123456789 până joi", "amount date"],
  ["Am ajuns acasă", ""],
  ["ok", ""],
  ["😂😂😂", ""],
  ["Dacă vrei, trecem pe la tine", ""],
  ["Nu știu încă", ""],
  ["Hai la o bere", ""],
  ["Dan a zis că vine", ""],
  ["Mersi, super!", ""],
  ["Am văzut filmul, e super", ""],
  ["Versiunea nouă e mai bună", ""],
  ["Te iubesc", ""],
  ["Sunt în trafic", ""],
  ["Ne vedem la 10:30", "time"],
  ["Mergem mâine cu mașina ta", "date"],
  ["Ne vedem acolo", ""],
  ["Mergem și noi", ""],

  // written after the guards above, to check they generalise
  ["Îmi dai 100 de lei înapoi când poți", "amount"],
  ["Am primit 2.500 lei salariu", "amount"],
  ["Biletul e 45 ron", "amount"],
  ["Mă costă 12 euro pe lună Netflixul", "amount"],
  ["Pay me back 20 dollars tomorrow", "amount date"],
  ["Contul meu: RO66BACX0000001234567890", "amount"],
  ["Am 2 bilete la concert", ""],
  ["Mai sunt 3 zile până la vacanță", ""],
  ["Clasa a 5-a B", ""],
  ["Parola e mama1234", ""],
  ["Vineri seara mergem la teatru", "date"],
  ["Pe 25 decembrie suntem la bunici", "date"],
  ["Examenul e pe 7 iulie", "date"],
  ["Luni dimineață am ședință", "date"],
  ["Next Tuesday works for me", "date"],
  ["Am plecat de 2 luni din firmă", ""],
  ["Mai stai puțin", ""],
  ["Mai bine mâine", "date"],
  ["Ne vedem la 17:00 la cafenea", "time"],
  ["Vin pe la 5 după-amiaza", "time"],
  ["Deschid la 9 dimineața", "time"],
  ["See you at 7:30", "time"],
  ["Am terminat la 3 din 4 probe", ""],
  ["Copilul are 7 luni", ""],
  ["Strada Republicii nr. 3, bloc 4", "address"],
  ["Suntem în Piața Victoriei", "address"],
  ["Stau pe strada Lipscani", "address"],
  ["Coletul vine la Bd. Iuliu Maniu 7", "address"],
  ["Nu mai e pe calea bună", ""],
  ["Am pus poza pe instagram.com/ana.pop", "link"],
  ["Uite https://bit.ly/3xYz", "link"],
  ["Mail-ul e dan.popescu@gmail.com", ""],
  ["Vrei să mergem la film", "question"],
  ["Ce părere ai", "question"],
  ["Unde ne vedem", "question"],
  ["Cât costă", "question"],
  ["Care e treaba", "question"],
  ["Do you have the keys", "question"],
  ["Why is it so late", "question"],
  ["Ce noroc am avut", ""],
  ["Când termin, te sun", ""],
  ["Where I grew up it was different", ""],
  ["Mersi pentru tot", ""],
  ["Sunt obosit azi", "date"],

  // the review's false positives
  ["Ești un geniu", ""],
  ["Ești acasă", ""],
  ["rămâne cum am vorbit", ""],
  ["stai liniștit, rămâne cum am vorbit", ""],
  ["Transferat 2 fișiere", ""],
  ["total: 3 colete", ""],
  ["Transferat 200 de fișiere", ""],
  ["am luat nota 9.10", ""],
  ["update la versiunea 2.10", ""],
  ["Media e 8.50 anul ăsta", ""],
  ["din 12.09 până în 15.09", "date"],
  ["Plata se face pana pe 15.10", "date"],
  ["Scadența 25.10", "date"],
  ["transfer 100", "amount"],
  ["suma e 4 mii", "amount"],
  ["Avans 500 si restul la livrare", "amount"],
  ["Hai la 2 beri", ""],
  ["Joi la 7 fix", "date time"],
  ["Ședința a fost mutată de la 14 la 16", "time"],
];

const labelled = CASES.map(([text, markers]) => ({ text, expected: new Set(markers.split(" ").filter(Boolean)) }));

test("the sentence set is large enough to mean something, and every label is a marker", () => {
  assert.ok(labelled.length >= 150, `${labelled.length} sentences`);
  for (const { expected } of labelled) for (const marker of expected) assert.ok(SIGNALS.includes(marker), marker);
  for (const marker of SIGNALS) {
    const positives = labelled.filter(({ expected }) => expected.has(marker)).length;
    assert.ok(positives >= 8, `${marker}: only ${positives} positives`);
  }
});

test("every marker keeps its precision and recall over the sentence set", () => {
  const rows = [];
  const misses = [];
  for (const marker of SIGNALS) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { text, expected } of labelled) {
      const got = signalsOf(text).has(marker);
      const want = expected.has(marker);
      if (got && want) tp++;
      else if (got) {
        fp++;
        misses.push(`+${marker}: ${text}`);
      } else if (want) {
        fn++;
        misses.push(`-${marker}: ${text}`);
      }
    }
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    rows.push({ marker, precision: +precision.toFixed(3), recall: +recall.toFixed(3), tp, fp, fn });
  }
  const report = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${misses.join("\n")}`;
  if (process.env.WAZAP_SIGNALS_REPORT) console.error(report);
  for (const row of rows) {
    assert.ok(row.precision >= 0.95, `${row.marker} precision ${row.precision}\n${report}`);
    const floor = row.marker === "question" ? 0.8 : 0.9;
    assert.ok(row.recall >= floor, `${row.marker} recall ${row.recall}\n${report}`);
  }
});

test("markers are a set, empty for nothing to read, and a link's digits and query string mark nothing else", () => {
  assert.deepEqual([...signalsOf("")], []);
  assert.deepEqual([...signalsOf(null)], []);
  assert.deepEqual([...signalsOf("   ")], []);
  assert.deepEqual([...signalsOf("[sticker]")], []);
  assert.deepEqual([...signalsOf("https://shop.ro/p?pret=150lei&data=12.09&ora=10:30")].sort(), ["link"]);
  assert.deepEqual([...signalsOf("Plătești 150 lei până vineri la 10?")].sort(), ["amount", "date", "question", "time"]);
  assert.deepEqual([...signalsOf("PLATESTI 150 LEI PANA VINERI LA 10?")].sort(), ["amount", "date", "question", "time"], "case and diacritics do not matter");
});
