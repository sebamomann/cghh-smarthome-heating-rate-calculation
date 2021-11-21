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

const getIntervals = async (range, measurement) => {
    const query = `from(bucket: "${bucket}") 
    |> range(start: -${range}) 
    |> filter(fn: (r) => r["_measurement"] == "${measurement}") 
    |> filter(fn: (r) => r["_field"] == "setTemperature")`;

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

    await calculateDurations(range, measurement);
};

const calculateDurations = async (range, measurement) => {
    const query = `from(bucket: "${bucket}") 
    |> range(start: -${range}) 
    |> filter(fn: (r) => r["_measurement"] == "${measurement}") 
    |> filter(fn: (r) => r["_field"] == "temperature")`;

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
            }

            const tempIsAlreadyHigher = value >= heatingIntervals[intervalIndex].desired;

            if (tempIsAlreadyHigher) {
                const reached = interpolateTimestampWhenTempWasReached(lastDate, date, lastTemp, value, intervalIndex);
                heatingIntervals[intervalIndex].reached = reached;

                intervalIndex++;
            } else {
                lastDate = date;
                lastTemp = value;
            }
        } else if (moment(date).isAfter(moment(heatingIntervals[intervalIndex].end))) {
            intervalIndex++;
        }
    });

    calculateHeatingRate(measurement);
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
            neededDegrees: neededDegrees,
            ratePerDegree: ratePerDegree,
        });
    });

    calculatedHeatingRates.sort((a, b) => a.neededDegrees - b.neededDegrees);
    rateInformations[measurement] = [...calculatedHeatingRates];
};

const run = async () => {
    const range = "30d";
    const measurements = ["Godi-Saal", "Seitenbereich", "Jugendraum EG", "Jugendraum 2. OG", "Kleinkindbereich", "Foyer"];

    for (let measurement of measurements) {
        heatingIntervals = [];
        await getIntervals(range, measurement);
    }

    // console.log(rateInformations);

    for (let [key, value] of Object.entries(rateInformations)) {
        const name = key;
        console.log(name);
        value.forEach((v) => {
            if (!v) return;
            console.log(String(v.neededDegrees).replace(".", ",") + ";" + String(v.ratePerDegree).replace(".", ","));
        });
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