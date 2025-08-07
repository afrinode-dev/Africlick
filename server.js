const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const nodemailer = require('nodemailer');
const app = express();
const port = process.env.PORT || 3000;

// Configuration
const config = {
    minWithdraw: 500, // 500 points = 5€
    pointsToMoneyRatio: 100, // 100 points = 1€
    wheelAttemptsPerDay: 1,
    offerWalls: {
        cpaGrip: {
            userId: 'YOUR_CPAGRIP_USER_ID',
            iframeUrl: 'https://www.cpagrip.com/offer_wall.php?user=YOUR_CPAGRIP_USER_ID&type=2'
        },
        ogAds: {
            userId: 'YOUR_OGADS_USER_ID',
            iframeUrl: 'https://api.ogads.com/v1/offers?user_id=YOUR_OGADS_USER_ID'
        },
        adWorkMedia: {
            userId: 'YOUR_ADWORKMEDIA_USER_ID',
            iframeUrl: 'https://www.adworkmedia.com/api/v1/get_offers?api_key=YOUR_API_KEY'
        }
    },
    airtelMoney: {
        apiKey: 'YOUR_AIRTEL_API_KEY',
        apiUrl: 'https://api.airtel.africa',
        merchantId: 'YOUR_MERCHANT_ID'
    },
    email: {
        service: 'gmail',
        auth: {
            user: 'afrinode.tech@gmail.com',
            pass: 'Afri@Node2025!' // Remplacez par le mot de passe de l'application
        }
    }
};

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
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        verified BOOLEAN DEFAULT 0,
        points INTEGER DEFAULT 0,
        last_wheel_spin DATETIME,
        wheel_attempts_left INTEGER DEFAULT ${config.wheelAttemptsPerDay},
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS verification_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        points INTEGER NOT NULL,
        type TEXT NOT NULL,
        icon TEXT,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS user_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'completed',
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (task_id) REFERENCES tasks (id)
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
    
    // Insérer des tâches exemple si la table est vide
    db.get('SELECT COUNT(*) as count FROM tasks', [], (err, row) => {
        if (err) {
            return console.error(err.message);
        }
        
        if (row.count === 0) {
            const defaultTasks = [
                ['Regarder une publicité', 'Regardez une vidéo publicitaire de 30 secondes', 10, 'ad', 'fas fa-ad'],
                ['Tester une application', 'Installez et utilisez l\'application pendant 1 minute', 50, 'app', 'fas fa-mobile-alt'],
                ['Visiter un site web', 'Restez sur le site pendant au moins 30 secondes', 15, 'visit', 'fas fa-globe'],
                ['Partager sur Facebook', 'Partagez notre lien sur votre profil', 20, 'share', 'fas fa-share-alt'],
                ['Inviter un ami', 'Parrainez un ami qui s\'inscrit et complète une tâche', 100, 'referral', 'fas fa-user-friends']
            ];
            
            const stmt = db.prepare('INSERT INTO tasks (title, description, points, type, icon) VALUES (?, ?, ?, ?, ?)');
            defaultTasks.forEach(task => {
                stmt.run(task);
            });
            stmt.finalize();
        }
    });
});

// Configuration du transporteur email
const transporter = nodemailer.createTransport({
    service: config.email.service,
    auth: config.email.auth
});

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '/')));
app.use(bodyParser.urlencoded({ extended: true }));

// Routes API
app.get('/api/tasks', (req, res) => {
    db.all('SELECT * FROM tasks WHERE is_active = 1', [], (err, tasks) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(tasks);
    });
});

app.post('/api/register', (req, res) => {
    const { username, phone, email, password } = req.body;
    
    if (!username || !phone || !email || !password) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    
    // Validation de l'email
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
        return res.status(400).json({ error: 'Adresse e-mail invalide' });
    }
    
    // Vérifier si l'utilisateur existe déjà
    db.get('SELECT id FROM users WHERE phone = ? OR email = ?', [phone, email], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (row) {
            return res.status(400).json({ error: 'Ce numéro ou adresse e-mail est déjà enregistré' });
        }
        
        // Générer un code de vérification
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        
        // Envoyer le code par email
        const mailOptions = {
            from: config.email.auth.user,
            to: email,
            subject: 'Code de vérification Africlick',
            text: `Ton code de vérification est : ${verificationCode}`
        };
        
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('Erreur lors de l\'envoi de l\'email:', error);
                return res.status(500).json({ error: 'Erreur lors de l\'envoi du code de vérification' });
            }
            
            console.log('Email envoyé:', info.response);
            
            // Créer un nouvel utilisateur (non vérifié)
            db.run('INSERT INTO users (username, phone, email, password, points) VALUES (?, ?, ?, ?, ?)', 
                [username, phone, email, password, 50], 
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    
                    // Enregistrer le code de vérification
                    db.run('INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?)', 
                        [email, verificationCode, expiresAt.toISOString()], (err) => {
                            if (err) {
                                return res.status(500).json({ error: err.message });
                            }
                            
                            // Retourner l'utilisateur créé (sans mot de passe)
                            res.json({ 
                                success: true,
                                userId: this.lastID,
                                email: email,
                                message: 'Code de vérification envoyé à votre adresse e-mail'
                            });
                        });
                });
        });
    });
});

app.post('/api/verify-account', (req, res) => {
    const { email, code } = req.body;
    
    if (!email || !code) {
        return res.status(400).json({ error: 'Email et code requis' });
    }
    
    // Vérifier le code
    db.get('SELECT * FROM verification_codes WHERE email = ? AND code = ? AND expires_at > datetime("now") ORDER BY created_at DESC LIMIT 1', 
        [email, code], (err, row) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            if (!row) {
                return res.status(400).json({ error: 'Code invalide ou expiré' });
            }
            
            // Marquer l'utilisateur comme vérifié
            db.run('UPDATE users SET verified = 1 WHERE email = ?', [email], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                
                // Supprimer le code utilisé
                db.run('DELETE FROM verification_codes WHERE email = ?', [email], (err) => {
                    if (err) {
                        console.error('Erreur lors de la suppression du code:', err.message);
                    }
                    
                    // Récupérer l'utilisateur vérifié
                    db.get('SELECT id, username, phone, email, points FROM users WHERE email = ?', [email], (err, user) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        
                        res.json({ 
                            success: true,
                            user: user,
                            message: 'Compte vérifié avec succès'
                        });
                    });
                });
            });
        });
});

app.post('/api/resend-code', (req, res) => {
    const { email } = req.body;
    
    if (!email) {
        return res.status(400).json({ error: 'Email requis' });
    }
    
    // Vérifier que l'utilisateur existe et n'est pas déjà vérifié
    db.get('SELECT id FROM users WHERE email = ? AND verified = 0', [email], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!user) {
            return res.status(400).json({ error: 'Aucun compte non vérifié trouvé avec cet email' });
        }
        
        // Générer un nouveau code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        
        // Envoyer le code par email
        const mailOptions = {
            from: config.email.auth.user,
            to: email,
            subject: 'Code de vérification Africlick',
            text: `Ton code de vérification est : ${verificationCode}`
        };
        
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('Erreur lors de l\'envoi de l\'email:', error);
                return res.status(500).json({ error: 'Erreur lors de l\'envoi du code de vérification' });
            }
            
            console.log('Email envoyé:', info.response);
            
            // Enregistrer le nouveau code
            db.run('INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?)', 
                [email, verificationCode, expiresAt.toISOString()], (err) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    
                    res.json({ 
                        success: true,
                        message: 'Nouveau code envoyé à votre adresse e-mail'
                    });
                });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { phone, password } = req.body;
    
    if (!phone || !password) {
        return res.status(400).json({ error: 'Numéro et mot de passe requis' });
    }
    
    db.get('SELECT id, username, phone, email, points, verified, last_wheel_spin, wheel_attempts_left FROM users WHERE phone = ? AND password = ?', 
        [phone, password], 
        (err, user) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            if (!user) {
                return res.status(401).json({ error: 'Identifiants incorrects' });
            }
            
            if (!user.verified) {
                return res.status(403).json({ 
                    error: 'Compte non vérifié',
                    email: user.email,
                    message: 'Veuillez vérifier votre compte avant de vous connecter'
                });
            }
            
            res.json(user);
        });
});

app.post('/api/complete-task', (req, res) => {
    const { userId, taskId } = req.body;
    
    if (!userId || !taskId) {
        return res.status(400).json({ error: 'ID utilisateur et ID tâche requis' });
    }
    
    // Vérifier que la tâche existe et obtenir les points
    db.get('SELECT points FROM tasks WHERE id = ?', [taskId], (err, task) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!task) {
            return res.status(404).json({ error: 'Tâche non trouvée' });
        }
        
        // Enregistrer la tâche complétée
        db.run('INSERT INTO user_tasks (user_id, task_id) VALUES (?, ?)', [userId, taskId], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            // Mettre à jour les points de l'utilisateur
            db.run('UPDATE users SET points = points + ? WHERE id = ?', [task.points, userId], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                
                // Récupérer les nouvelles informations de l'utilisateur
                db.get('SELECT points FROM users WHERE id = ?', [userId], (err, user) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    
                    res.json({ 
                        points: user.points,
                        taskPoints: task.points
                    });
                });
            });
        });
    });
});

app.post('/api/spin-wheel', (req, res) => {
    const { userId } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'ID utilisateur requis' });
    }
    
    // Vérifier les tentatives de roue
    db.get('SELECT last_wheel_spin, wheel_attempts_left FROM users WHERE id = ?', [userId], (err, user) => {
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
                
                // Déterminer le prix gagné (simulation)
                const prizes = [50, 20, 30, 0, 10, 25, 15, 100];
                const prize = prizes[Math.floor(Math.random() * prizes.length)];
                
                if (prize > 0) {
                    // Ajouter les points
                    db.run('UPDATE users SET points = points + ? WHERE id = ?', [prize, userId], (err) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        
                        // Enregistrer dans l'historique
                        db.run('INSERT INTO user_tasks (user_id, task_id, status) VALUES (?, ?, ?)', 
                            [userId, 0, 'wheel'], (err) => {
                                if (err) {
                                    return res.status(500).json({ error: err.message });
                                }
                                
                                res.json({
                                    prize,
                                    attemptsLeft,
                                    message: prize > 0 ? `Vous avez gagné ${prize} points!` : 'Dommage, vous n\'avez rien gagné cette fois.'
                                });
                            });
                    });
                } else {
                    res.json({
                        prize: 0,
                        attemptsLeft,
                        message: 'Dommage, vous n\'avez rien gagné cette fois.'
                    });
                }
            });
    });
});

app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, phoneNumber, method } = req.body;
    
    if (!userId || !amount || !phoneNumber || !method) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    
    // Vérifier que l'utilisateur a assez de points
    db.get('SELECT points FROM users WHERE id = ?', [userId], async (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'Utilisateur non trouvé' });
        }
        
        const requiredPoints = amount;
        const moneyAmount = (amount / config.pointsToMoneyRatio).toFixed(2);
        
        if (user.points < requiredPoints) {
            return res.status(400).json({ error: 'Points insuffisants' });
        }
        
        // En production, vous utiliseriez l'API Airtel Money comme ceci:
        /*
        try {
            const response = await axios.post(`${config.airtelMoney.apiUrl}/merchant/v1/payments`, {
                amount: moneyAmount,
                currency: 'EUR',
                msisdn: phoneNumber,
                merchant_id: config.airtelMoney.merchantId,
                reference: `WITHDRAW_${userId}_${Date.now()}`
            }, {
                headers: {
                    'Authorization': `Bearer ${config.airtelMoney.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.data.status === 'success') {
                // Créer la demande de retrait
                db.run('INSERT INTO withdrawals (user_id, amount, phone_number, method, transaction_id, status) VALUES (?, ?, ?, ?, ?, ?)', 
                    [userId, amount, phoneNumber, method, response.data.transaction_id, 'completed'], (err) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        
                        // Déduire les points
                        db.run('UPDATE users SET points = points - ? WHERE id = ?', [requiredPoints, userId], (err) => {
                            if (err) {
                                return res.status(500).json({ error: err.message });
                            }
                            
                            res.json({ 
                                success: true,
                                transactionId: response.data.transaction_id,
                                amount: moneyAmount,
                                message: 'Retrait effectué avec succès'
                            });
                        });
                    });
            } else {
                res.status(400).json({ error: 'Échec du retrait: ' + response.data.message });
            }
        } catch (error) {
            res.status(500).json({ error: 'Erreur lors du retrait: ' + error.message });
        }
        */
        
        // Pour la démo, nous simulons une réponse réussie
        db.run('INSERT INTO withdrawals (user_id, amount, phone_number, method, status) VALUES (?, ?, ?, ?, ?)', 
            [userId, amount, phoneNumber, method, 'pending'], function(err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                
                // Déduire les points
                db.run('UPDATE users SET points = points - ? WHERE id = ?', [requiredPoints, userId], (err) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    
                    res.json({ 
                        success: true,
                        withdrawalId: this.lastID,
                        amount: moneyAmount,
                        message: 'Demande de retrait enregistrée. Traitement sous 24h.'
                    });
                });
            });
    });
});

app.get('/api/offer-walls', (req, res) => {
    res.json({
        cpaGrip: config.offerWalls.cpaGrip.iframeUrl,
        ogAds: config.offerWalls.ogAds.iframeUrl,
        adWorkMedia: config.offerWalls.adWorkMedia.iframeUrl
    });
});

app.get('/api/user-history/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.all(`SELECT ut.completed_at as date, t.title as task, t.points, ut.status 
            FROM user_tasks ut
            LEFT JOIN tasks t ON ut.task_id = t.id
            WHERE ut.user_id = ?
            UNION ALL
            SELECT created_at as date, 'Retrait ' || method || ' (' || phone_number || ')' as task, -amount as points, status
            FROM withdrawals
            WHERE user_id = ?
            ORDER BY date DESC`, [userId, userId], (err, history) => {
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