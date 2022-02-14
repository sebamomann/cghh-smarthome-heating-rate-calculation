const { InfluxDB } = require('@influxdata/influxdb-client');
const moment = require('moment');

require("dotenv").config();

// You can generate a Token from the "Tokens Tab" in the UI
const url = process.env.INFLUX_URL;
const token = process.env.ADMIN_TOKEN;
const org = process.env.ORG;
const bucket = process.env.BUCKET;

const client = new InfluxDB({ url: url, token: token });

const queryApi = client.getQueryApi(org);

var heatingIntervals = []; // {start: date, end: date, desired: number, reached: date}[]
var rateInformations = {};

const getIntervals = async (range, name) => {
    const query = `from(bucket: "${bucket}") 
    |> range(start: -${range}) 
    |> filter(fn: (r) => r["_measurement"] == "sensoric") 
    |> filter(fn: (r) => r["_field"] == "setTemperature")
    |> filter(fn: (r) => r["name"] == "${name}")
    |> filter(fn: (r) => r["type"] == "HEATING")`;

    const data = await queryApi.collectRows(query);

    if (data.length == 0) return;

    var lastTemp = data[0]._value;
    var start = data[0]._time;

    data.forEach((row) => {
        const date = row._time;
        const value = row._value;

        if (value > lastTemp) {
            start = date;
        } else if (value < lastTemp) {
            const obj = {
                start: start,
                end: date,
                desired: lastTemp
            };

            heatingIntervals.push(obj);
        };

        lastTemp = value;
    });

    await calculateDurations(range, name);
};

const calculateDurations = async (range, name) => {
    const query = `from(bucket: "${bucket}") 
    |> range(start: -${range}) 
    |> filter(fn: (r) => r["_measurement"] == "sensoric") 
    |> filter(fn: (r) => r["_field"] == "temperature")
    |> filter(fn: (r) => r["name"] == "${name}")
    |> filter(fn: (r) => r["type"] == "HEATING")`;

    const maxIndex = heatingIntervals.length;

    const data = await queryApi.collectRows(query);

    if (data.length == 0) return;

    var intervalIndex = 0;
    var lastDate = data[0]._time;
    var lastTemp = data[0]._value;

    data.forEach((row, i) => {
        const date = row._time;
        const value = row._value;

        if (intervalIndex === maxIndex) return;

        if (moment(date).isBetween(moment(heatingIntervals[intervalIndex].start), moment(heatingIntervals[intervalIndex].end))) {
            if (!heatingIntervals[intervalIndex].startTemp) {
                heatingIntervals[intervalIndex].startTemp = value;
                lastTemp = value; // reset last temp for llater check if window open
            }

            const tempIsAlreadyHigher = value >= heatingIntervals[intervalIndex].desired;

            if (tempIsAlreadyHigher) {
                const reached = interpolateTimestampWhenTempWasReached(lastDate, date, lastTemp, value, intervalIndex);
                heatingIntervals[intervalIndex].reached = reached;

                intervalIndex++;
            } else {
                if (i > 1 && value < lastTemp) {
                    delete heatingIntervals[intervalIndex];
                    intervalIndex++;
                    return;
                }

                lastDate = date;
                lastTemp = value;
            }
        } else if (moment(date).isAfter(moment(heatingIntervals[intervalIndex].end))) {
            intervalIndex++;
        }
    });

    calculateHeatingRate(name);
};

const calculateHeatingRate = (measurement) => {
    const calculatedHeatingRates = [];

    heatingIntervals.forEach(interval => {
        if (!interval.desired || !interval.startTemp || !interval.reached) return;

        const neededDegrees = Math.round((interval.desired - interval.startTemp) * 100) / 100;

        if (neededDegrees < 0) return;

        const start = moment(interval.start);
        const reached = moment(interval.reached);
        const durationInMinutes = reached.diff(start, "minutes");


        const heatingRate = durationInMinutes / neededDegrees;
        const ratePerDegree = Math.round(heatingRate * 100) / 100;

        calculatedHeatingRates.push({
            startTemp: interval.startTemp,
            neededDegrees: neededDegrees,
            ratePerDegree: ratePerDegree,
        });
    });

    calculatedHeatingRates.sort((a, b) => a.neededDegrees - b.neededDegrees);
    rateInformations[measurement] = [...calculatedHeatingRates];
};

const run = async () => {
    const range = "44d";
    const measurements = ["Godi-Saal", "Seitenbereich", "Jugendraum_EG", "Jugendraum_2._OG"];

    for (let measurement of measurements) {
        heatingIntervals = [];
        await getIntervals(range, measurement);
    }


    for (let [key, value] of Object.entries(rateInformations)) {
        const name = key;
        console.log(name);
        value.forEach((v) => {
            if (!v) return;
            console.log(String(v.neededDegrees).replace(".", ",") + ";" + String(v.ratePerDegree).replace(".", ","));
        });
    }

    console.log("-----------------------------");
    console.log("-----------------------------");
    console.log("-----------------------------");
    console.log("-----------------------------");
    console.log("-----------------------------");
    const minTemp = 13;
    const maxTemp = 20;
    for (let [key, value] of Object.entries(rateInformations)) {
        const name = key;
        console.log(name);
        for (let i = minTemp; i < maxTemp; i++) {
            const tempSpec = value.filter(v => v.startTemp > i && v.startTemp <= i + 1);
            console.log("Temp: " + i + " - " + (i + 1));
            tempSpec.forEach((v) => {
                if (!v) return;
                console.log(String(v.neededDegrees).replace(".", ",") + ";" + String(v.ratePerDegree).replace(".", ","));
            });
        }
    }
};

function interpolateTimestampWhenTempWasReached(lastDate, date, lastTemp, value, intervalIndex) {
    const lastDte = lastDate;
    const currDte = date;
    const diffInSeconds = moment(currDte).diff(moment(lastDte), "seconds");

    const lastTmp = lastTemp;
    const currTmp = value;
    const tempDiff = currTmp - lastTmp;

    const increasePerSecond = tempDiff / diffInSeconds;

    const desired = heatingIntervals[intervalIndex].desired;
    const interpolatedMinutes = Math.round((desired - lastTmp) / increasePerSecond);

    const reached = moment(lastDte).add(interpolatedMinutes, "seconds");

    return reached;
}

run();