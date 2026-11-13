
/* =========================
ROLLING STOCK DATA
========================= */

const rollingStock = [
  {
    type: "bus",
    manufacturer: "BMC",
    model: "Belde 220-SLF",
    year: 2005,
    quantity: 10,
    image: "https://s1.busphoto.eu/photo/02/39/61/239613.jpg",
    lines: ["26", "28", "187", "188", "190", "285"]
  },

  {
    type: "bus",
    manufacturer: "BMC",
    model: "Procity CNG 2017",
    year: 2017,
    quantity: 59,
    image: "https://s1.busphoto.eu/photo/05/33/38/533381.jpg",
    lines: ["18", "20", "21", "22", "24", "27", "29", "30", "31", "81", "86", "112", "115", "117", "118", "119"]
  },

  {
    type: "bus",
    manufacturer: "BMC",
    model: "Procity CNG 2018",
    year: 2018,
    quantity: 69,
    image: "https://s1.busphoto.eu/photo/04/18/15/418156.jpg",
    lines: ["18", "20", "21", "22", "24", "27", "29", "30", "31", "72", "64", "67", "77", "81", "86", "111", "112", "115", "117", "118", "119", "404", "604"]
  },

  {
    type: "bus",
    manufacturer: "Higer",
    model: "KLQ6125GEV3",
    year: 2019,
    quantity: 54,
    image: "https://s1.busphoto.eu/photo/04/09/76/409764.jpg",
    lines: ["60", "73", "74", "123", "186", "288"]
  },

  {
    type: "bus",
    manufacturer: "Higer",
    model: "KLQ6832GEV",
    year: 2022,
    quantity: 22,
    image: "https://s1.busphoto.eu/photo/05/09/81/509813.jpg",
    lines: ["23", "82", "101", "107", "180"]
  },

  {
    type: "bus",
    manufacturer: "Karsan",
    model: "e-Jest",
    year: 2022,
    quantity: 35,
    image: "https://s1.busphoto.eu/photo/07/30/10/730101.jpg",
    lines: ["103", "182", "801", "802", "804", "806"]
  },

  {
    type: "bus",
    manufacturer: "Yutong",
    model: "E12LF",
    year: 2018,
    quantity: 20,
    image: "https://s1.busphoto.eu/photo/06/21/80/621808.jpg",
    lines: ["9", "23", "82", "309", "404", "604"]
  },

  {
    type: "bus",
    manufacturer: "Yutong",
    model: "ZK6126HGA",
    year: 2016,
    quantity: 109,
    image: "https://s1.busphoto.eu/photo/01/67/30/167309.jpg",
    lines: ["26", "42", "56", "64", "67", "68", "69", "70", "72", "75", "77", "98", "111", "150", "181", "183", "184", "185", "187", "188", "190", "191", "192", "314", "404", "604"]
  },

  {
    type: "bus",
    manufacturer: "Yutong",
    model: "ZK6126HGA CNG",
    year: 2018,
    quantity: 22,
    image: "https://s1.busphoto.eu/photo/06/89/49/689499.jpg",
    lines: ["67", "69", "70", "75", "184", "187", "188", "190", "314", "404", "604"]
  },

  {
    type: "bus",
    manufacturer: "Mercedes",
    model: "Conecto LF",
    year: 2008,
    quantity: 34,
    image: "https://s1.busphoto.eu/photo/03/53/47/353477.jpg",
    lines: ["42", "56", "58", "59", "77", "108", "150", "260"]
  },

  {
    type: "bus",
    manufacturer: "Mercedes",
    model: "Conecto NG",
    year: 2008,
    quantity: 3,
    image: "https://s1.busphoto.eu/photo/09/14/58/914583.jpg",
    lines: ["20", "21", "22"]
  },

  {
    type: "bus",
    manufacturer: "Mercedes",
    model: "O345 Conecto",
    year: 2002,
    quantity: 2,
    image: "https://s1.busphoto.eu/photo/03/55/00/355001.jpg",
    lines: ["77", "150"]
  },

  {
    type: "bus",
    manufacturer: "Mercedes",
    model: "O345 Conecto G",
    year: 2003,
    quantity: 27,
    image: "https://s1.busphoto.eu/photo/07/31/97/731974.jpg",
    lines: ["11", "54", "76", "77", "78", "79", "83", "88", "108", "213", "285", "305", "404", "413"]
  },

  {
    type: "bus",
    manufacturer: "Mercedes",
    model: "O530 CapaCity",
    year: 2017,
    quantity: 11,
    image: "https://s1.busphoto.eu/photo/02/07/24/207248.jpg",
    lines: ["–"]
  },

  {
    type: "bus",
    manufacturer: "Mercedes",
    model: "Intouro ME",
    year: 2015,
    quantity: 21,
    image: "https://s1.busphoto.eu/photo/04/67/02/467029.jpg",
    lines: ["44", "47", "49", "59", "61", "63", "66"]
  },

  {
    type: "bus",
    manufacturer: "MAN",
    model: "Lion's City CNG",
    year: 2017,
    quantity: 2,
    image: "https://s1.busphoto.eu/photo/07/00/17/700178.jpg",
    lines: ["86"]
  },

  {
    type: "bus",
    manufacturer: "MAN",
    model: "Lion's City DD",
    year: 2009,
    quantity: 4,
    image: "https://s1.busphoto.eu/photo/09/09/06/909062.jpg",
    lines: ["X43", "78", "120", "183"]
  },

  {
    type: "bus",
    manufacturer: "MAN",
    model: "Lion's City G CNG 2014",
    year: 2014,
    quantity: 124,
    image: "https://s1.busphoto.eu/photo/01/67/69/167691.jpg",
    lines: ["11", "76", "78", "83", "85", "88", "94", "102", "108", "Х10", "111", "120", "204", "213", "280", "294", "304", "305", "310", "404", "413"]
  },

  {
    type: "bus",
    manufacturer: "MAN",
    model: "Lion's City G CNG 2018",
    year: 2018,
    quantity: 60,
    image: "https://s1.busphoto.eu/photo/05/42/40/542409.jpg",
    lines: ["11", "76", "78", "83", "85", "88", "94", "102", "108", "Х10", "111", "120", "204", "213", "280", "294", "304", "305", "310", "404", "413"]
  },

  {
    type: "bus",
    manufacturer: "MAN",
    model: "Lion's City LE",
    year: 2018,
    quantity: 1,
    image: "https://s1.busphoto.eu/photo/02/88/89/288890.jpg",
    lines: ["20", "21", "22"]
  },

  {
    type: "bus",
    manufacturer: "MAN",
    model: "SG262",
    year: 1999,
    quantity: 4,
    image: "https://s1.busphoto.eu/photo/06/59/88/659880.jpg",
    lines: ["26", "78", "79", "285"]
  },

  {
    type: "bus",
    manufacturer: "Neoplan",
    model: "N4426/3 Centroliner",
    year: 2003,
    quantity: 1,
    image: "https://s1.busphoto.eu/photo/05/23/35/523356.jpg",
    lines: ["X43", "120"]
  },

  {
    type: "trolley",
    manufacturer: "Škoda",
    model: "26Tr Solaris III",
    year: 2010,
    quantity: 30,
    image: "https://transphoto.org/photo/04/04/58/404588.jpg",
    lines: ["3", "4", "8", "11"]
  },

  {
    type: "trolley",
    manufacturer: "Škoda",
    model: "27Tr Solaris III",
    year: 2013,
    quantity: 50,
    image: "https://transphoto.org/photo/17/11/92/1711920.jpg",
    lines: ["1", "2", "3", "5", "6", "7", "9"]
  },

  {
    type: "trolley",
    manufacturer: "Škoda",
    model: "27Tr Solaris IV",
    year: 2021,
    quantity: 30,
    image: "https://transphoto.org/photo/22/10/96/2210968.jpg",
    lines: ["1", "6", "7", "9"]
  },

  {
    type: "trolley",
    manufacturer: "Ikarus",
    model: "280.92T",
    year: 1985,
    quantity: 4,
    image: "https://transphoto.org/photo/21/97/08/2197082.jpg",
    lines: ["6"]
  },

  {
    type: "tram",
    manufacturer: "ЗТС",
    model: "T8K-503",
    year: 2000,
    quantity: 9,
    image: "https://transphoto.org/photo/13/14/03/1314039.jpg",
    lines: ["11"]
  },

  {
    type: "tram",
    manufacturer: "ЗТС",
    model: "T8M-700M",
    year: 1990,
    quantity: 4,
    image: "https://transphoto.org/photo/15/42/96/1542966.jpg",
    lines: ["11"]
  },

  {
    type: "tram",
    manufacturer: "ČKD Tatra",
    model: "T6A2B",
    year: 1990,
    quantity: 40,
    image: "https://transphoto.org/photo/20/51/14/2051146.jpg",
    lines: ["10", "11", "13", "15"]
  },

  {
    type: "tram",
    manufacturer: "ČKD Tatra",
    model: "T6A2 SF",
    year: 1999,
    quantity: 17,
    image: "https://transphoto.org/photo/17/91/07/1791079.jpg",
    lines: ["1", "3"]
  },

  {
    type: "tram",
    manufacturer: "Pesa",
    model: "Swing-122NaSF",
    year: 2013,
    quantity: 67,
    image: "https://transphoto.org/photo/13/14/07/1314079.jpg",
    lines: ["4", "5", "6", "7", "18", "27"]
  },

  {
    type: "tram",
    manufacturer: "ЗТС",
    model: "Т8М-700IT (Inekon)",
    year: 2007,
    quantity: 18,
    image: "https://transphoto.org/photo/22/11/27/2211275.jpg",
    lines: ["6", "11", "12"]
  },

  {
    type: "tram",
    manufacturer: "Schindler",
    model: "Waggon AG Be 4-6",
    year: 1990,
    quantity: 25,
    image: "https://transphoto.org/photo/10/91/92/1091922.jpg",
    lines: ["8", "12"]
  },

  {
    type: "tram",
    manufacturer: "ČKD Tatra",
    model: "T6B5",
    year: 1988,
    quantity: 37,
    image: "https://transphoto.org/photo/10/52/76/1052768.jpg",
    lines: ["20", "21"]
  },

  {
    type: "tram",
    manufacturer: "ČKD Tatra",
    model: "T6A5",
    year: 1995,
    quantity: 52,
    image: "https://transphoto.org/photo/11/51/94/1151940.jpg",
    lines: ["21", "22"]
  },

  {
    type: "tram",
    manufacturer: "Duewag",
    model: "GT8",
    year: 1960,
    quantity: 6,
    image: "https://transphoto.org/photo/22/08/76/2208767.jpg",
    lines: ["23"]
  },

  {
    type: "metro",
    manufacturer: "МВМ",
    model: "81-717.4/81-714.4",
    year: 1989,
    quantity: 8,
    image: "https://transphoto.org/photo/22/84/16/2284160.jpg",
    lines: ["1", "2", "4"]
  },

  {
    type: "metro",
    manufacturer: "МВМ",
    model: "81-717.4К",
    year: 2021,
    quantity: 16,
    image: "https://transphoto.org/photo/19/50/75/1950754.jpg",
    lines: ["1", "2", "4"]
  },

  {
    type: "metro",
    manufacturer: "МВМ",
    model: "81-740.2/81-741.2",
    year: 2005,
    quantity: 9,
    image: "https://transphoto.org/photo/12/14/59/1214597.jpg",
    lines: ["1", "2", "4"]
  },

  {
    type: "metro",
    manufacturer: "МВМ",
    model: "81-740.2Б/81-741.2Б",
    year: 2010,
    quantity: 31,
    image: "https://transphoto.org/photo/18/02/07/1802078.jpg",
    lines: ["1", "2", "4"]
  },

  {
    type: "metro",
    manufacturer: "Siemens",
    model: "Inspiro SF",
    year: 2017,
    quantity: 90,
    image: "https://transphoto.org/photo/18/49/45/1849450.jpg",
    lines: ["3"]
  },

  {
    type: "metro",
    manufacturer: "Škoda",
    model: "Varsovia",
    year: 2025,
    quantity: 7,
    image: "https://transphoto.org/photo/21/88/37/2188373.jpg",
    lines: ["1", "2", "4"]
  },
];

/* =========================
RENDER FUNCTION
========================= */

function renderStock() {

  const grid = document.getElementById("stockGrid");

  if (!grid) {
    console.error("stockGrid not found");
    return;
  }

  grid.innerHTML = "";

  const groups = {
    bus: "Автобуси",
    trolley: "Тролейбуси",
    tram: "Трамваи",
    metro: "Метро"
  };

  Object.keys(groups).forEach(type => {

    const items = rollingStock.filter(v => v.type === type);

    if (items.length === 0) return;

    // SECTION TITLE
const title = document.createElement("h2");
title.textContent = groups[type];
title.id = type + "Section";
title.style.margin = "24px 0 12px";
title.style.fontSize = "20px";
title.style.gridColumn = "1 / -1";

grid.appendChild(title);

    // CARDS
    items.forEach(item => {

      const card = document.createElement("div");
      card.className = "stock-card";

      card.innerHTML = `
        <img class="stock-image" src="${item.image}" alt="${item.model}" />
        <div class="stock-author">${item.author || ""}</div>

        <div class="stock-body">

          <h3>${item.manufacturer} ${item.model}</h3>

          <p><strong>Произведен:</strong> ${item.year} г.</p>
          <p><strong>В експлоатация:</strong> ${item.quantity} бр.</p>

          <div class="stock-lines">
            ${item.lines.map(line => {

              let meta = { color: "#111827", text: "white" };

              switch (item.type) {
                case "bus":
                  if (["<lines for tourist logic here>"].includes(line)) {
                    meta = { color: "#006838", text: "white" };
                  } else {
                    meta = { color: "#BD202E", text: "white" };
                  }
                  break;

                case "tram":
                  meta = { color: "#F7941F", text: "white" };
                  break;

                case "trolley":
                  meta = { color: "#2AA9E0", text: "white" };
                  break;

                case "metro":
                  if (line === "1") meta = { color: "#ec2029", text: "white" };
                  if (line === "2") meta = { color: "#1077bc", text: "white" };
                  if (line === "3") meta = { color: "#3bb44b", text: "white" };
                  if (line === "4") meta = { color: "#fcd403", text: "black" };
                  break;

                case "night":
                  meta = { color: "#000000", text: "white" };
                  break;
              }

              const isMetro = item.type === "metro";

              return `
                <div
                  class="stock-line-pill ${isMetro ? 'stock-metro-pill' : ''}"
                  style="background:${meta.color}; color:${meta.text}"
                >
                  ${line}
                </div>
              `;
            }).join("")}
          </div>

        </div>
      `;

      grid.appendChild(card);
    });

  });
}

/* =========================
INIT
========================= */

document.addEventListener("DOMContentLoaded", renderStock);

function scrollToStock(type) {

  const section = document.getElementById(type + "Section");

  if (!section) return;

  section.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });

}
