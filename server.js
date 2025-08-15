const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

// Configuration
const config = {
    minDeposit: 1000,    // 1000 FCFA = 10 points
    minWithdraw: 10,     // 10 points = 1000 FCFA
    pointsToMoneyRatio: 0.01, // 1000 FCFA = 10 points (1 point = 100 FCFA)
    wheelAttemptsPerDay: 1,
    referralBonus: 20,   // Points bonus pour parrainage
    profilePicturesDir: './uploads/profile_pictures',
    moovMoney: {
        apiKey: 'YOUR_MOOV_API_KEY',
        apiUrl: 'https://api.moov-africa.com',
        merchantId: 'YOUR_MERCHANT_ID'
    },
    airtelMoney: {
        apiKey: 'YOUR_AIRTEL_API_KEY',
        apiUrl: 'https://api.airtel.africa',
        merchantId: 'YOUR_MERCHANT_ID'
    }
};

// Créer le répertoire pour les photos de profil si inexistant
if (!fs.existsSync(config.profilePicturesDir)) {
    fs.mkdirSync(config.profilePicturesDir, { recursive: true });
}

// Configuration de multer pour le stockage des photos de profil
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, config.profilePicturesDir);
    },
    filename: (req, file, cb) => {
        const userId = req.params.userId;
        const ext = path.extname(file.originalname);
        cb(null, `profile_${userId}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Seules les images sont autorisées!'), false);
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB
    }
});

// Initialisation de la base de données
const db = new sqlite3.Database('database.sqlite', (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
});

// Création des tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        points INTEGER DEFAULT 0,
        referral_code TEXT UNIQUE,
        total_deposited INTEGER DEFAULT 0,
        wheel_multiplier REAL DEFAULT 1.0,
        last_wheel_spin DATETIME,
        wheel_attempts_left INTEGER DEFAULT ${config.wheelAttemptsPerDay},
        profile_picture TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        icon TEXT,
        min_bet INTEGER DEFAULT 1,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS user_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        game_id INTEGER NOT NULL,
        bet_amount INTEGER NOT NULL,
        multiplier REAL,
        result INTEGER NOT NULL, -- gain ou perte
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (game_id) REFERENCES games (id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        phone_number TEXT NOT NULL,
        method TEXT NOT NULL,
        points_credited INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        transaction_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        phone_number TEXT NOT NULL,
        method TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        transaction_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id INTEGER NOT NULL,
        referee_id INTEGER NOT NULL,
        referee_username TEXT NOT NULL,
        bonus_given BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (referrer_id) REFERENCES users (id),
        FOREIGN KEY (referee_id) REFERENCES users (id)
    )`);
    
    // Insérer les jeux si la table est vide
    db.get('SELECT COUNT(*) as count FROM games', [], (err, row) => {
        if (err) {
            return console.error(err.message);
        }
        
        if (row.count === 0) {
            const defaultGames = [
                ['Aviator', 'Parier sur un multiplicateur avant que l\'avion ne décolle', 'fas fa-plane', 1],
                ['JetX', 'Parier sur un multiplicateur avant que le jet n\'explose', 'fas fa-rocket', 1],
                ['Plinko', 'Lâchez une bille et gagnez selon où elle atterrit', 'fas fa-bullseye', 1],
                ['Dice', 'Devinez si le dé sera plus haut ou plus bas que votre cible', 'fas fa-dice', 1],
                ['Mines', 'Trouvez des diamants sans tomber sur une mine', 'fas fa-bomb', 1],
                ['Limbo', 'Devinez si le multiplicateur sera plus bas que votre cible', 'fas fa-chart-line', 1],
                ['Crazy Time', 'Jeu de roue avec bonus et multiplicateurs fous', 'fas fa-redo', 1],
                ['Sweet Bonanza', 'Jeu de bonbons avec cascades et multiplicateurs', 'fas fa-candy-cane', 1],
                ['Book of Ra', 'Jeu de machines à sous avec tours gratuits', 'fas fa-book', 1],
                ['Roulette Live', 'Roulette en direct avec croupier réel', 'fas fa-chess-queen', 1]
            ];
            
            const stmt = db.prepare('INSERT INTO games (title, description, icon, min_bet) VALUES (?, ?, ?, ?)');
            defaultGames.forEach(game => {
                stmt.run(game);
            });
            stmt.finalize();
        }
    });
});

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '/')));
app.use(bodyParser.urlencoded({ extended: true }));

// Routes API

// Authentification
app.post('/api/register', (req, res) => {
    const { username, phone, password, referralCode } = req.body;
    
    if (!username || !phone || !password) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    
    if (username.length < 3) {
        return res.status(400).json({ error: 'Le pseudo doit contenir au moins 3 caractères' });
    }
    
    if (!phone.match(/^[0-9]{9}$/)) {
        return res.status(400).json({ error: 'Numéro de téléphone invalide (9 chiffres requis)' });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }
    
    // Vérifier si l'utilisateur existe déjà
    db.get('SELECT id FROM users WHERE phone = ?', [phone], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (row) {
            return res.status(400).json({ error: 'Ce numéro est déjà enregistré' });
        }
        
        // Générer un code de parrainage unique
        const referralCodeForUser = generateReferralCode(username);
        
        // Créer un nouvel utilisateur
        db.run('INSERT INTO users (username, phone, password, referral_code) VALUES (?, ?, ?, ?)', 
            [username, phone, password, referralCodeForUser], 
            function(err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                
                const userId = this.lastID;
                
                // Gérer le parrainage si un code a été fourni
                if (referralCode) {
                    db.get('SELECT id FROM users WHERE referral_code = ?', [referralCode], (err, referrer) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        
                        if (referrer) {
                            db.run('INSERT INTO referrals (referrer_id, referee_id, referee_username) VALUES (?, ?, ?)', 
                                [referrer.id, userId, username], (err) => {
                                    if (err) {
                                        return res.status(500).json({ error: err.message });
                                    }
                                    
                                    sendUserResponse(userId, 'Inscription avec parrainage réussie! Le bonus sera crédité après votre premier dépôt.');
                                });
                        } else {
                            sendUserResponse(userId, 'Inscription réussie! (Code de parrainage invalide)');
                        }
                    });
                } else {
                    sendUserResponse(userId, 'Inscription réussie!');
                }
            });
    });
});

function generateReferralCode(username) {
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    return `${username.substring(0, 3).toUpperCase()}${randomNum}`;
}

function sendUserResponse(userId, message) {
    db.get('SELECT id, username, phone, points, referral_code FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        res.json({
            user,
            message
        });
    });
}

app.post('/api/login', (req, res) => {
    const { phone, password } = req.body;
    
    if (!phone || !password) {
        return res.status(400).json({ error: 'Numéro et mot de passe requis' });
    }
    
    db.get('SELECT id, username, phone, points, referral_code, total_deposited, wheel_multiplier, profile_picture FROM users WHERE phone = ? AND password = ?', 
        [phone, password], 
        (err, user) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            if (!user) {
                return res.status(401).json({ error: 'Identifiants incorrects' });
            }
            
            res.json(user);
        });
});

// Gestion du profil utilisateur
app.post('/api/change-password/:userId', (req, res) => {
    const userId = req.params.userId;
    const { currentPassword, newPassword, confirmPassword } = req.body;
    
    if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères' });
    }
    
    if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'Les nouveaux mots de passe ne correspondent pas' });
    }
    
    // Vérifier le mot de passe actuel
    db.get('SELECT password FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'Utilisateur non trouvé' });
        }
        
        if (user.password !== currentPassword) {
            return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
        }
        
        // Mettre à jour le mot de passe
        db.run('UPDATE users SET password = ? WHERE id = ?', [newPassword, userId], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            res.json({ success: true, message: 'Mot de passe changé avec succès' });
        });
    });
});

app.post('/api/upload-profile-picture/:userId', upload.single('profile_picture'), (req, res) => {
    const userId = req.params.userId;
    
    if (!req.file) {
        return res.status(400).json({ error: 'Aucun fichier téléchargé' });
    }
    
    const profilePicturePath = `/profile_pictures/${req.file.filename}`;
    
    db.run('UPDATE users SET profile_picture = ? WHERE id = ?', [profilePicturePath, userId], (err) => {
        if (err) {
            // Supprimer le fichier uploadé en cas d'erreur
            fs.unlinkSync(req.file.path);
            return res.status(500).json({ error: err.message });
        }
        
        res.json({ 
            success: true, 
            message: 'Photo de profil mise à jour',
            profilePicture: profilePicturePath
        });
    });
});

// Jeux
app.get('/api/games', (req, res) => {
    db.all('SELECT * FROM games WHERE is_active = 1', [], (err, games) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(games);
    });
});

app.post('/api/play-game', (req, res) => {
    const { userId, gameId, betAmount } = req.body;
    
    if (!userId || !gameId || !betAmount) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    
    // Vérifier que l'utilisateur a assez de points
    db.get('SELECT points FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'Utilisateur non trouvé' });
        }
        
        if (user.points < betAmount) {
            return res.status(400).json({ error: 'Points insuffisants' });
        }
        
        // Vérifier que le jeu existe et a une mise minimale
        db.get('SELECT min_bet FROM games WHERE id = ?', [gameId], (err, game) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            if (!game) {
                return res.status(404).json({ error: 'Jeu non trouvé' });
            }
            
            if (betAmount < game.min_bet) {
                return res.status(400).json({ error: `La mise minimale est de ${game.min_bet} point` });
            }
            
            // Simuler le jeu (ici nous simulons l'Aviator)
            const multiplier = simulateGame(gameId);
            const winAmount = multiplier > 1 ? Math.floor(betAmount * multiplier) : 0;
            const result = winAmount - betAmount;
            
            // Enregistrer la partie
            db.run('INSERT INTO user_games (user_id, game_id, bet_amount, multiplier, result) VALUES (?, ?, ?, ?, ?)', 
                [userId, gameId, betAmount, multiplier, result], (err) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    
                    // Mettre à jour les points de l'utilisateur
                    db.run('UPDATE users SET points = points + ? WHERE id = ?', [result, userId], (err) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        
                        // Récupérer les nouvelles informations de l'utilisateur
                        db.get('SELECT points FROM users WHERE id = ?', [userId], (err, updatedUser) => {
                            if (err) {
                                return res.status(500).json({ error: err.message });
                            }
                            
                            res.json({ 
                                multiplier,
                                winAmount,
                                newBalance: updatedUser.points,
                                message: multiplier > 1 ? 
                                    `Félicitations! Vous avez gagné ${winAmount} points!` : 
                                    `Dommage! Vous avez perdu ${betAmount} points.`
                            });
                        });
                    });
                });
        });
    });
});

function simulateGame(gameId) {
    // Simulation simple basée sur le type de jeu
    switch(gameId) {
        case 1: // Aviator
            return Math.random() * 5 + 0.5; // Entre 0.5x et 5.5x
        case 2: // JetX
            return Math.random() * 10; // Entre 0x et 10x
        case 3: // Plinko
            return [0.5, 1, 2, 3, 5][Math.floor(Math.random() * 5)]; // Multiplicateurs fixes
        default:
            return Math.random() * 3; // Par défaut entre 0x et 3x
    }
}

// Roue de la chance
app.post('/api/spin-wheel', (req, res) => {
    const { userId } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'ID utilisateur requis' });
    }
    
    // Vérifier les tentatives de roue
    db.get('SELECT last_wheel_spin, wheel_attempts_left, wheel_multiplier FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'Utilisateur non trouvé' });
        }
        
        let attemptsLeft = user.wheel_attempts_left;
        let lastSpin = user.last_wheel_spin;
        
        // Vérifier si c'est un nouveau jour
        if (lastSpin) {
            const lastSpinDate = new Date(lastSpin);
            const today = new Date();
            
            if (lastSpinDate.getDate() !== today.getDate() || 
                lastSpinDate.getMonth() !== today.getMonth() || 
                lastSpinDate.getFullYear() !== today.getFullYear()) {
                attemptsLeft = config.wheelAttemptsPerDay;
            }
        } else {
            attemptsLeft = config.wheelAttemptsPerDay;
        }
        
        if (attemptsLeft <= 0) {
            return res.status(400).json({ error: 'Plus de tentatives disponibles aujourd\'hui' });
        }
        
        // Décrémenter les tentatives
        attemptsLeft -= 1;
        
        // Mettre à jour l'utilisateur
        db.run('UPDATE users SET last_wheel_spin = CURRENT_TIMESTAMP, wheel_attempts_left = ? WHERE id = ?', 
            [attemptsLeft, userId], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                
                // Déterminer le prix gagné (avec multiplicateur)
                const basePrizes = [50, 20, 30, -10, 10, 25, 15, 100];
                const prize = basePrizes[Math.floor(Math.random() * basePrizes.length)] * user.wheel_multiplier;
                const roundedPrize = Math.round(prize);
                
                if (roundedPrize > 0) {
                    // Ajouter les points
                    db.run('UPDATE users SET points = points + ? WHERE id = ?', [roundedPrize, userId], (err) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        
                        res.json({
                            prize: roundedPrize,
                            attemptsLeft,
                            message: `Vous avez gagné ${roundedPrize} points!`
                        });
                    });
                } else {
                    // Pour les pertes, nous ne déduisons pas les points ici (c'est déjà un nombre négatif)
                    res.json({
                        prize: roundedPrize,
                        attemptsLeft,
                        message: `Dommage! Vous avez perdu ${Math.abs(roundedPrize)} points.`
                    });
                }
            });
    });
});

// Dépôts
app.post('/api/deposit', async (req, res) => {
    const { userId, amount, phoneNumber, method } = req.body;
    
    if (!userId || !amount || !phoneNumber || !method) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    
    if (amount < config.minDeposit) {
        return res.status(400).json({ error: `Le montant minimum est de ${config.minDeposit} FCFA` });
    }
    
    // Calculer les points à créditer
    const pointsToAdd = Math.floor(amount * config.pointsToMoneyRatio);
    
    // En production, vous utiliseriez l'API de paiement ici:
    /*
    try {
        const apiConfig = method === 'moov' ? config.moovMoney : config.airtelMoney;
        const response = await axios.post(`${apiConfig.apiUrl}/payments`, {
            amount,
            phone: phoneNumber,
            merchant_id: apiConfig.merchantId,
            reference: `DEPOSIT_${userId}_${Date.now()}`
        }, {
            headers: {
                'Authorization': `Bearer ${apiConfig.apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.data.status !== 'success') {
            return res.status(400).json({ error: 'Échec du dépôt: ' + response.data.message });
        }
    */
    
    // Pour la démo, nous simulons une réponse réussie
    try {
        // Créer le dépôt
        db.run('INSERT INTO deposits (user_id, amount, phone_number, method, points_credited, status, transaction_id) VALUES (?, ?, ?, ?, ?, ?, ?)', 
            [userId, amount, phoneNumber, method, pointsToAdd, 'completed', `SIMULATED_${Date.now()}`], 
            function(err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                
                // Mettre à jour les points et le total dépensé
                db.run('UPDATE users SET points = points + ?, total_deposited = total_deposited + ? WHERE id = ?', 
                    [pointsToAdd, amount, userId], (err) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        
                        // Mettre à jour le multiplicateur de la roue (1 + 0.5 par tranche de 5000 FCFA)
                        db.run('UPDATE users SET wheel_multiplier = 1 + (total_deposited / 5000) * 0.5 WHERE id = ?', 
                            [userId], (err) => {
                                if (err) {
                                    return res.status(500).json({ error: err.message });
                                }
                                
                                // Vérifier les parrainages en attente
                                checkPendingReferrals(userId, res);
                                
                                // Récupérer les nouvelles infos utilisateur
                                db.get('SELECT points, wheel_multiplier FROM users WHERE id = ?', [userId], (err, user) => {
                                    if (err) {
                                        return res.status(500).json({ error: err.message });
                                    }
                                    
                                    res.json({ 
                                        success: true,
                                        pointsAdded: pointsToAdd,
                                        newBalance: user.points,
                                        wheelMultiplier: user.wheel_multiplier,
                                        message: `Dépôt de ${amount} FCFA réussi! ${pointsToAdd} points ajoutés.`
                                    });
                                });
                            });
                    });
            });
    } catch (error) {
        res.status(500).json({ error: 'Erreur lors du dépôt: ' + error.message });
    }
});

function checkPendingReferrals(userId, res) {
    // Vérifier si cet utilisateur a été parrainé
    db.get('SELECT referrer_id FROM referrals WHERE referee_id = ? AND bonus_given = 0', [userId], (err, referral) => {
        if (err || !referral) return;
        
        // Donner le bonus au parrain
        db.run('UPDATE users SET points = points + ? WHERE id = ?', 
            [config.referralBonus, referral.referrer_id], (err) => {
                if (err) return;
                
                // Marquer le parrainage comme complété
                db.run('UPDATE referrals SET bonus_given = 1 WHERE referee_id = ? AND referrer_id = ?', 
                    [userId, referral.referrer_id], (err) => {
                        if (err) return;
                    });
            });
    });
}

// Retraits
app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, phoneNumber, method } = req.body;
    
    if (!userId || !amount || !phoneNumber || !method) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    
    if (amount < config.minWithdraw) {
        return res.status(400).json({ error: `Le montant minimum est de ${config.minWithdraw} points` });
    }
    
    // Vérifier que l'utilisateur a assez de points
    db.get('SELECT points FROM users WHERE id = ?', [userId], async (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'Utilisateur non trouvé' });
        }
        
        if (user.points < amount) {
            return res.status(400).json({ error: 'Points insuffisants' });
        }
        
        // Calculer le montant en FCFA
        const moneyAmount = (amount / config.pointsToMoneyRatio) * 1000;
        
        // En production, vous utiliseriez l'API de paiement ici:
        /*
        try {
            const apiConfig = method === 'moov' ? config.moovMoney : config.airtelMoney;
            const response = await axios.post(`${apiConfig.apiUrl}/payouts`, {
                amount: moneyAmount,
                phone: phoneNumber,
                merchant_id: apiConfig.merchantId,
                reference: `WITHDRAW_${userId}_${Date.now()}`
            }, {
                headers: {
                    'Authorization': `Bearer ${apiConfig.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.data.status !== 'success') {
                return res.status(400).json({ error: 'Échec du retrait: ' + response.data.message });
            }
        */
        
        // Pour la démo, nous simulons une réponse réussie
        try {
            // Créer la demande de retrait
            db.run('INSERT INTO withdrawals (user_id, amount, phone_number, method, status, transaction_id) VALUES (?, ?, ?, ?, ?, ?)', 
                [userId, amount, phoneNumber, method, 'pending', `SIMULATED_${Date.now()}`], 
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    
                    // Déduire les points
                    db.run('UPDATE users SET points = points - ? WHERE id = ?', 
                        [amount, userId], (err) => {
                            if (err) {
                                return res.status(500).json({ error: err.message });
                            }
                            
                            res.json({ 
                                success: true,
                                amount: moneyAmount,
                                message: 'Demande de retrait enregistrée. Traitement sous 24h.'
                            });
                        });
                });
        } catch (error) {
            res.status(500).json({ error: 'Erreur lors du retrait: ' + error.message });
        }
    });
});

// Parrainage
app.get('/api/referral-info/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.get('SELECT referral_code FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.status(500).json({ error: err ? err.message : 'Utilisateur non trouvé' });
        }
        
        db.all(`SELECT r.referee_username, r.created_at, r.bonus_given, u.points > 0 as has_deposited
                FROM referrals r
                JOIN users u ON r.referee_id = u.id
                WHERE r.referrer_id = ?`, [userId], (err, referrals) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            res.json({
                referralCode: user.referral_code,
                referrals: referrals || [],
                bonusAmount: config.referralBonus
            });
        });
    });
});

// Historique
app.get('/api/user-history/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.all(`SELECT 'game' as type, ug.created_at as date, g.title as description, 
                   ug.result as points, 
                   CASE WHEN ug.result >= 0 THEN 'Gagné' ELSE 'Perdu' END as status
            FROM user_games ug
            JOIN games g ON ug.game_id = g.id
            WHERE ug.user_id = ?
            
            UNION ALL
            
            SELECT 'deposit' as type, created_at as date, 
                   'Dépôt ' || method || ' (' || phone_number || ')' as description, 
                   points_credited as points, 'Complété' as status
            FROM deposits
            WHERE user_id = ? AND status = 'completed'
            
            UNION ALL
            
            SELECT 'withdrawal' as type, created_at as date, 
                   'Retrait ' || method || ' (' || phone_number || ')' as description, 
                   -amount as points, status
            FROM withdrawals
            WHERE user_id = ?
            
            UNION ALL
            
            SELECT 'wheel' as type, last_wheel_spin as date, 
                   'Roue de la chance' as description, 
                   NULL as points, 'Spun' as status
            FROM users
            WHERE id = ? AND last_wheel_spin IS NOT NULL
            
            ORDER BY date DESC`, 
    [userId, userId, userId, userId], (err, history) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        res.json(history);
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