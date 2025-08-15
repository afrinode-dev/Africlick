const sqlite3 = require('sqlite3').verbose();

// Configuration de la base de données
const db = new sqlite3.Database('africlick.db', (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the Africlick SQLite database.');
});

// Fonctions utilitaires
function runQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function getQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function allQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

module.exports = {
    db,
    runQuery,
    getQuery,
    allQuery
};