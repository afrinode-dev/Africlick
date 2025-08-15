const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const app = express();
const port = process.env.PORT || 3000;

// Configuration
const config = {
    minDeposit: 1000,    // 1000 FCFA = 10 points
    minWithdraw: 10,     // 10 points = 1000 FCFA
    pointsToMoneyRatio: 0.01, // 1000 FCFA = 10 points (1 point = 100 FCFA)
    adminPhone: '077279698',
    adminPassword: 'lionel12345',
    houseEdge: 0.3,      // 30% de commission pour l'admin
    reservePercentage: 0.7 // 70% va dans la réserve pour payer les gains
};

// Initialisation de la base de données
const db = new sqlite3.Database('africlick.db', (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the Africlick SQLite database.');
});

// Création des tables
db.serialize(() => {
    // Table utilisateurs
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        points INTEGER DEFAULT 0,
        is_admin BOOLEAN DEFAULT 0,
        referral_code TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Table réserve d'argent (pertes des joueurs)
    db.run(`CREATE TABLE IF NOT EXISTS money_reserve (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount INTEGER NOT NULL,
        source TEXT NOT NULL,  // 'game_loss' ou 'deposit_fee'
        user_id INTEGER,
        game_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Table bénéfices admin
    db.run(`CREATE TABLE IF NOT EXISTS admin_earnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount INTEGER NOT NULL,
        source TEXT NOT NULL,  // 'game_commission', 'deposit_fee', 'withdrawal_fee'
        user_id INTEGER,
        game_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Table transactions
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,  // 'deposit', 'withdrawal', 'game_win', 'game_loss'
        amount INTEGER NOT NULL,
        status TEXT DEFAULT 'pending', // 'completed', 'failed'
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Table jeux
    db.run(`CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        min_bet INTEGER DEFAULT 1,
        is_active BOOLEAN DEFAULT 1
    )`);

    // Créer le compte admin s'il n'existe pas
    db.get("SELECT id FROM users WHERE phone = ?", [config.adminPhone], (err, row) => {
        if (!row) {
            const hashedPassword = bcrypt.hashSync(config.adminPassword, 8);
            db.run(`INSERT INTO users (username, phone, password, is_admin) 
                    VALUES (?, ?, ?, 1)`, 
                    ['Admin', config.adminPhone, hashedPassword]);
            console.log('Compte admin créé');
        }
    });

    // Insérer les jeux par défaut
    const defaultGames = [
        {name: 'Aviator', min_bet: 1},
        {name: 'JetX', min_bet: 1},
        {name: 'Plinko', min_bet: 1},
        {name: 'Mines', min_bet: 1},
        {name: 'Dice', min_bet: 1},
        {name: 'Limbo', min_bet: 1}
    ];
    
    db.get("SELECT COUNT(*) as count FROM games", (err, row) => {
        if (row.count === 0) {
            const stmt = db.prepare("INSERT INTO games (name, min_bet) VALUES (?, ?)");
            defaultGames.forEach(game => {
                stmt.run(game.name, game.min_bet);
            });
            stmt.finalize();
            console.log('Jeux par défaut insérés');
        }
    });
});

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '/')));
app.use(bodyParser.urlencoded({ extended: true }));

// Middleware d'authentification
function authenticate(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Accès non autorisé' });

    db.get("SELECT * FROM users WHERE phone = ?", [token], (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Accès non autorisé' });
        req.user = user;
        next();
    });
}

// Routes API

// Authentification
app.post('/api/login', (req, res) => {
    const { phone, password } = req.body;
    
    db.get("SELECT * FROM users WHERE phone = ?", [phone], (err, user) => {
        if (err || !user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Identifiants incorrects' });
        }
        
        // Retourner les infos utilisateur sans le mot de passe
        const { password: _, ...userData } = user;
        res.json({
            ...userData,
            token: user.phone // Utilisation du numéro comme token simplifié
        });
    });
});

app.post('/api/register', (req, res) => {
    const { username, phone, password, referralCode } = req.body;
    
    // Validation simple
    if (!username || !phone || !password) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    // Vérifier si l'utilisateur existe déjà
    db.get("SELECT id FROM users WHERE phone = ?", [phone], (err, row) => {
        if (row) {
            return res.status(400).json({ error: 'Ce numéro est déjà enregistré' });
        }

        // Générer un code de parrainage
        const referralCodeForUser = generateReferralCode(username);
        const hashedPassword = bcrypt.hashSync(password, 8);

        db.run(`INSERT INTO users (username, phone, password, referral_code) 
                VALUES (?, ?, ?, ?)`, 
                [username, phone, hashedPassword, referralCodeForUser], 
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }

                    // Gérer le parrainage si un code a été fourni
                    if (referralCode) {
                        db.get("SELECT id FROM users WHERE referral_code = ?", [referralCode], (err, referrer) => {
                            if (referrer) {
                                // Enregistrer le parrainage (le bonus sera crédité après premier dépôt)
                                db.run("INSERT INTO transactions (user_id, type, amount, status, details) VALUES (?, ?, ?, ?, ?)",
                                    [referrer.id, 'referral_bonus', config.referralBonus, 'pending', `Parrainage de ${username}`]);
                            }
                        });
                    }

                    res.json({ 
                        success: true,
                        message: 'Inscription réussie!',
                        referralCode: referralCodeForUser
                    });
                });
    });
});

function generateReferralCode(username) {
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    return `${username.substring(0, 3).toUpperCase()}${randomNum}`;
}

// Gestion des fonds
app.post('/api/deposit', authenticate, (req, res) => {
    const { amount, phone } = req.body;
    const userId = req.user.id;

    if (!amount || amount < config.minDeposit) {
        return res.status(400).json({ error: `Le dépôt minimum est de ${config.minDeposit} FCFA` });
    }

    // Calculer les points à créditer
    const pointsToAdd = Math.floor(amount * config.pointsToMoneyRatio);
    
    // Calculer la commission (10%)
    const commission = Math.floor(amount * 0.1);
    const netAmount = amount - commission;

    // Démarrer une transaction
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        // 1. Ajouter les points à l'utilisateur
        db.run("UPDATE users SET points = points + ? WHERE id = ?", [pointsToAdd, userId]);

        // 2. Enregistrer la transaction de dépôt
        db.run(`INSERT INTO transactions (user_id, type, amount, status, details) 
                VALUES (?, ?, ?, ?, ?)`,
                [userId, 'deposit', amount, 'completed', `Dépôt de ${amount} FCFA`]);

        // 3. Ajouter la commission aux bénéfices admin
        db.run(`INSERT INTO admin_earnings (amount, source, user_id) 
                VALUES (?, ?, ?)`,
                [commission, 'deposit_fee', userId]);

        // 4. Vérifier les parrainages en attente
        db.get(`SELECT t.id, t.user_id as referrer_id 
                FROM transactions t
                JOIN users u ON t.user_id = u.id
                WHERE t.type = 'referral_bonus' 
                AND t.status = 'pending'
                AND t.details LIKE ?`, [`%${req.user.username}%`], (err, referral) => {
            if (referral) {
                // Créditer le parrain
                db.run("UPDATE users SET points = points + ? WHERE id = ?", 
                      [config.referralBonus, referral.referrer_id]);

                // Marquer le bonus comme payé
                db.run("UPDATE transactions SET status = 'completed' WHERE id = ?", 
                      [referral.id]);

                // Enregistrer la transaction
                db.run(`INSERT INTO transactions (user_id, type, amount, status, details) 
                        VALUES (?, ?, ?, ?, ?)`,
                        [referral.referrer_id, 'referral_bonus', config.referralBonus, 'completed', `Bonus parrainage pour ${req.user.username}`]);
            }

            db.run("COMMIT", (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: 'Erreur lors du dépôt' });
                }

                res.json({ 
                    success: true,
                    pointsAdded: pointsToAdd,
                    message: `Dépôt de ${amount} FCFA réussi! ${pointsToAdd} points ajoutés.`
                });
            });
        });
    });
});

app.post('/api/withdraw', authenticate, (req, res) => {
    const { amount, phone } = req.body;
    const userId = req.user.id;

    if (!amount || amount < config.minWithdraw) {
        return res.status(400).json({ error: `Le retrait minimum est de ${config.minWithdraw} points` });
    }

    // Vérifier le solde
    db.get("SELECT points FROM users WHERE id = ?", [userId], (err, user) => {
        if (user.points < amount) {
            return res.status(400).json({ error: 'Solde insuffisant' });
        }

        // Calculer le montant en FCFA et la commission (10%)
        const moneyAmount = (amount / config.pointsToMoneyRatio) * 1000;
        const commission = Math.floor(moneyAmount * 0.1);
        const netAmount = moneyAmount - commission;

        // Démarrer une transaction
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");

            // 1. Déduire les points
            db.run("UPDATE users SET points = points - ? WHERE id = ?", [amount, userId]);

            // 2. Enregistrer la transaction de retrait
            db.run(`INSERT INTO transactions (user_id, type, amount, status, details) 
                    VALUES (?, ?, ?, ?, ?)`,
                    [userId, 'withdrawal', amount, 'pending', `Retrait de ${moneyAmount} FCFA vers ${phone}`]);

            // 3. Ajouter la commission aux bénéfices admin
            db.run(`INSERT INTO admin_earnings (amount, source, user_id) 
                    VALUES (?, ?, ?)`,
                    [commission, 'withdrawal_fee', userId]);

            db.run("COMMIT", (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: 'Erreur lors du retrait' });
                }

                res.json({ 
                    success: true,
                    amount: netAmount,
                    message: 'Demande de retrait enregistrée. Traitement sous 24h.'
                });
            });
        });
    });
});

// Jeux
app.post('/api/play-game', authenticate, (req, res) => {
    const { gameId, betAmount } = req.body;
    const userId = req.user.id;

    // Vérifier le jeu et la mise
    db.get("SELECT * FROM games WHERE id = ?", [gameId], (err, game) => {
        if (!game) {
            return res.status(404).json({ error: 'Jeu non trouvé' });
        }

        if (betAmount < game.min_bet) {
            return res.status(400).json({ error: `La mise minimale est de ${game.min_bet} point` });
        }

        // Vérifier le solde
        db.get("SELECT points FROM users WHERE id = ?", [userId], (err, user) => {
            if (user.points < betAmount) {
                return res.status(400).json({ error: 'Solde insuffisant' });
            }

            // Simuler un résultat de jeu (ici c'est simplifié)
            const isWin = Math.random() > 0.5; // 50% de chance de gagner
            let multiplier, winAmount, result;

            if (isWin) {
                multiplier = 1 + Math.random() * 4; // Gain entre 1x et 5x
                winAmount = Math.floor(betAmount * multiplier);
                result = winAmount - betAmount;
            } else {
                multiplier = 0;
                winAmount = 0;
                result = -betAmount;
            }

            // Démarrer une transaction
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");

                if (isWin) {
                    // 1. Payer le joueur depuis la réserve
                    db.run("UPDATE users SET points = points + ? WHERE id = ?", [result, userId]);

                    // 2. Enregistrer le gain
                    db.run(`INSERT INTO transactions (user_id, type, amount, status, details) 
                            VALUES (?, ?, ?, ?, ?)`,
                            [userId, 'game_win', winAmount, 'completed', `Gain au jeu ${game.name} (${multiplier}x)`]);

                    // 3. Prélever de la réserve
                    db.run(`INSERT INTO money_reserve (amount, source, user_id, game_id) 
                            VALUES (?, ?, ?, ?)`,
                            [-winAmount, 'game_win', userId, gameId]);
                } else {
                    // 1. Déduire la perte
                    db.run("UPDATE users SET points = points - ? WHERE id = ?", [betAmount, userId]);

                    // 2. Enregistrer la perte
                    db.run(`INSERT INTO transactions (user_id, type, amount, status, details) 
                            VALUES (?, ?, ?, ?, ?)`,
                            [userId, 'game_loss', betAmount, 'completed', `Perte au jeu ${game.name}`]);

                    // 3. Ajouter à la réserve (70%)
                    const reserveAmount = Math.floor(betAmount * config.reservePercentage);
                    db.run(`INSERT INTO money_reserve (amount, source, user_id, game_id) 
                            VALUES (?, ?, ?, ?)`,
                            [reserveAmount, 'game_loss', userId, gameId]);

                    // 4. Ajouter la commission admin (30%)
                    const commission = Math.floor(betAmount * config.houseEdge);
                    db.run(`INSERT INTO admin_earnings (amount, source, user_id, game_id) 
                            VALUES (?, ?, ?, ?)`,
                            [commission, 'game_commission', userId, gameId]);
                }

                db.run("COMMIT", (err) => {
                    if (err) {
                        db.run("ROLLBACK");
                        return res.status(500).json({ error: 'Erreur lors du jeu' });
                    }

                    res.json({
                        result: isWin ? 'win' : 'loss',
                        multiplier,
                        winAmount,
                        newBalance: user.points + result,
                        message: isWin ? 
                            `Félicitations! Vous avez gagné ${winAmount} points!` : 
                            `Dommage! Vous avez perdu ${betAmount} points.`
                    });
                });
            });
        });
    });
});

// Admin - Récupérer les bénéfices
app.post('/api/admin/withdraw-earnings', authenticate, (req, res) => {
    if (!req.user.is_admin) {
        return res.status(403).json({ error: 'Accès refusé' });
    }

    // Calculer le total des bénéfices
    db.get("SELECT SUM(amount) as total FROM admin_earnings WHERE amount > 0", (err, row) => {
        const totalEarnings = row.total || 0;

        if (totalEarnings <= 0) {
            return res.status(400).json({ error: 'Aucun bénéfice disponible' });
        }

        // Démarrer une transaction
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");

            // 1. Marquer les bénéfices comme retirés (en les supprimant pour simplifier)
            db.run("DELETE FROM admin_earnings WHERE amount > 0");

            // 2. Enregistrer le retrait admin
            db.run(`INSERT INTO transactions (user_id, type, amount, status, details) 
                    VALUES (?, ?, ?, ?, ?)`,
                    [req.user.id, 'admin_withdrawal', totalEarnings, 'completed', 'Retrait des bénéfices administrateur']);

            db.run("COMMIT", (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: 'Erreur lors du retrait' });
                }

                res.json({ 
                    success: true,
                    amount: totalEarnings,
                    message: `Retrait de ${totalEarnings} points effectué avec succès.`
                });
            });
        });
    });
});

// Admin - Statistiques
app.get('/api/admin/stats', authenticate, (req, res) => {
    if (!req.user.is_admin) {
        return res.status(403).json({ error: 'Accès refusé' });
    }

    db.serialize(() => {
        db.get("SELECT SUM(amount) as total_reserve FROM money_reserve", (err, reserve) => {
            db.get("SELECT SUM(amount) as total_earnings FROM admin_earnings", (err, earnings) => {
                db.get("SELECT COUNT(*) as user_count FROM users WHERE is_admin = 0", (err, users) => {
                    res.json({
                        totalReserve: reserve.total_reserve || 0,
                        totalEarnings: earnings.total_earnings || 0,
                        userCount: users.user_count || 0
                    });
                });
            });
        });
    });
});

// Route pour servir l'application
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Démarrer le serveur
app.listen(port, () => {
    console.log(`Africlick server running at http://localhost:${port}`);
});