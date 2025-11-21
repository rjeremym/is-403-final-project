// Business Ideas Tracker - Main Application
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();

// View engine setup
app.set('view engine', 'ejs');
app.use(express.static('public'));

// Port configuration
const port = process.env.PORT || 3000;

// Session configuration
app.use(
    session({
        secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 // 24 hours
        }
    })
);

// Database configuration
const knex = require('knex')({
    client: 'pg',
    connection: {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'business_ideas',
        port: process.env.DB_PORT || 5432,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    }
});

// Body parser middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login');
    }
};

// ============= ROUTES =============

// Landing page
app.get('/', requireAuth, (req, res) => {
    res.render('landing', {
        username: req.session.username,
        firstName: req.session.firstName
    });
});

// Login page (GET)
app.get('/login', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.render('login', { error: null });
});

// Create Account page (GET)
app.get('/create-account', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/');
    }
    res.render('createAccount', { error: null });
});

app.use((req, res, next) => {
    res.locals.firstname = req.session.firstName || null;
    next();
});

// Create Account (POST)
app.post('/create-account', async (req, res) => {
    const { username, password, email, firstname, lastname } = req.body;

    try {
        // Check if username already exists
        const existingUser = await knex('security')
            .where({ username })
            .first();

        if (existingUser) {
            return res.render('createAccount', { 
                error: 'Username already exists. Please choose a different username.' 
            });
        }

        // Create new user
        await knex('security').insert({
            username,
            passwordhash: password,
            email,
            firstname,
            lastname
        });

        // Automatically log in the new user
        const newUser = await knex('security')
            .where({ username })
            .first();

        req.session.userId = newUser.userid;
        req.session.username = newUser.username;
        req.session.firstName = newUser.firstname;

        res.redirect('/');
    } catch (err) {
        console.error('Create account error:', err);
        res.render('createAccount', { 
            error: 'An error occurred. Please try again.' 
        });
    }
});

// Login (POST)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await knex('security')
            .where({ username, passwordhash: password })
            .first();

        if (user) {
            req.session.userId = user.userid;
            req.session.username = user.username;
            req.session.firstName = user.firstname;

            // Update last login
            await knex('security')
                .where({ userid: user.userid })
                .update({ lastlogin: knex.fn.now() });

            res.redirect('/');
        } else {
            res.render('login', { error: 'Invalid username or password' });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.render('login', { error: 'An error occurred. Please try again.' });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Add Idea page (GET)
app.get('/add-idea', requireAuth, (req, res) => {
    res.render('addIdea', {
        username: req.session.username,
        error: null
    });
});

// Add Idea (POST)
app.post('/add-idea', requireAuth, async (req, res) => {
    const {
        ideaname,
        ideadescription,
        marketingstrategy,
        targetcustomer,
        estimatedcost,
        timeline,
        potential
    } = req.body;

    try {
        // Convert marketing strategy to array if it's a single value
        let marketingArray = null;
        if (marketingstrategy) {
            marketingArray = Array.isArray(marketingstrategy) 
                ? marketingstrategy 
                : [marketingstrategy];
        }

        await knex('idea_details').insert({
            ideaname,
            ideadescription,
            marketingstrategy: marketingArray,
            targetcustomer: targetcustomer || null,
            estimatedcost: estimatedcost || null,
            timeline: timeline || null,
            potential: potential || null,
            userid: req.session.userId
        });

        res.redirect('/view-ideas');
    } catch (err) {
        console.error('Add idea error:', err);
        res.render('addIdea', {
            username: req.session.username,
            error: 'Failed to add idea. Please try again.'
        });
    }
});

// View Ideas page (GET)
app.get('/view-ideas', requireAuth, async (req, res) => {
    try {
        const { marketingstrategy, maxcost, ideaname, potential } = req.query;

        // Get ideas created by user
        let myIdeasQuery = knex('idea_details as i')
            .select(
                'i.*',
                's.username as creator_username',
                's.firstname as creator_firstname',
                's.lastname as creator_lastname',
                knex.raw('TRUE as is_owner')
            )
            .leftJoin('security as s', 'i.userid', 's.userid')
            .where('i.userid', req.session.userId);

        // Get ideas shared with user through collaborations
        let sharedIdeasQuery = knex('idea_details as i')
            .select(
                'i.*',
                's.username as creator_username',
                's.firstname as creator_firstname',
                's.lastname as creator_lastname',
                knex.raw('FALSE as is_owner')
            )
            .leftJoin('security as s', 'i.userid', 's.userid')
            .join('collaborations as c', 'i.ideaid', 'c.ideaid')
            .where('c.userid', req.session.userId)
            .whereNot('i.userid', req.session.userId);

        // Apply filters
        if (marketingstrategy) {
            myIdeasQuery = myIdeasQuery.whereRaw('? = ANY(marketingstrategy)', [marketingstrategy]);
            sharedIdeasQuery = sharedIdeasQuery.whereRaw('? = ANY(marketingstrategy)', [marketingstrategy]);
        }

        if (maxcost) {
            myIdeasQuery = myIdeasQuery.where('estimatedcost', '<=', parseFloat(maxcost));
            sharedIdeasQuery = sharedIdeasQuery.where('estimatedcost', '<=', parseFloat(maxcost));
        }

        if (ideaname) {
            myIdeasQuery = myIdeasQuery.whereRaw('LOWER(ideaname) LIKE LOWER(?)', [`%${ideaname}%`]);
            sharedIdeasQuery = sharedIdeasQuery.whereRaw('LOWER(ideaname) LIKE LOWER(?)', [`%${ideaname}%`]);
        }

        if (potential) {
            myIdeasQuery = myIdeasQuery.where('potential', '>=', parseInt(potential));
            sharedIdeasQuery = sharedIdeasQuery.where('potential', '>=', parseInt(potential));
        }

        const myIdeas = await myIdeasQuery;
        const sharedIdeas = await sharedIdeasQuery;
        const allIdeas = [...myIdeas, ...sharedIdeas].sort((a, b) => 
            new Date(b.createdat) - new Date(a.createdat)
        );

        res.render('viewIdeas', {
            username: req.session.username,
            ideas: allIdeas,
            filters: { marketingstrategy, maxcost, ideaname, potential }
        });
    } catch (err) {
        console.error('View ideas error:', err);
        res.status(500).send('Error loading ideas');
    }
});

// Edit Idea page (GET)
app.get('/edit-idea/:id', requireAuth, async (req, res) => {
    try {
        const idea = await knex('idea_details')
            .where({ ideaid: req.params.id })
            .first();

        if (!idea) {
            return res.redirect('/view-ideas');
        }

        // Check if user is owner or collaborator
        const isOwner = idea.userid === req.session.userId;
        const isCollaborator = await knex('collaborations')
            .where({ ideaid: req.params.id, userid: req.session.userId })
            .first();

        if (!isOwner && !isCollaborator) {
            return res.redirect('/view-ideas');
        }

        // Get all collaborators
        const collaborators = await knex('collaborations as c')
            .select('s.userid', 's.username', 's.firstname', 's.lastname')
            .join('security as s', 'c.userid', 's.userid')
            .where('c.ideaid', req.params.id);

        // Get all users for collaborator dropdown
        const allUsers = await knex('security')
            .select('userid', 'username', 'firstname', 'lastname')
            .whereNot('userid', idea.userid);

        res.render('editIdea', {
            username: req.session.username,
            idea,
            isOwner,
            collaborators,
            allUsers,
            error: null
        });
    } catch (err) {
        console.error('Edit idea page error:', err);
        res.redirect('/view-ideas');
    }
});

// Update Idea (POST)
app.post('/edit-idea/:id', requireAuth, async (req, res) => {
    const {
        ideaname,
        ideadescription,
        marketingstrategy,
        targetcustomer,
        estimatedcost,
        timeline,
        potential
    } = req.body;

    try {
        const idea = await knex('idea_details')
            .where({ ideaid: req.params.id })
            .first();

        if (!idea) {
            return res.redirect('/view-ideas');
        }

        // Check permissions
        const isOwner = idea.userid === req.session.userId;
        const isCollaborator = await knex('collaborations')
            .where({ ideaid: req.params.id, userid: req.session.userId })
            .first();

        if (!isOwner && !isCollaborator) {
            return res.redirect('/view-ideas');
        }

        // Convert marketing strategy to array
        let marketingArray = null;
        if (marketingstrategy) {
            marketingArray = Array.isArray(marketingstrategy) 
                ? marketingstrategy 
                : [marketingstrategy];
        }

        await knex('idea_details')
            .where({ ideaid: req.params.id })
            .update({
                ideaname,
                ideadescription,
                marketingstrategy: marketingArray,
                targetcustomer: targetcustomer || null,
                estimatedcost: estimatedcost || null,
                timeline: timeline || null,
                potential: potential || null,
                updatedat: knex.fn.now()
            });

        res.redirect('/view-ideas');
    } catch (err) {
        console.error('Update idea error:', err);
        res.redirect(`/edit-idea/${req.params.id}`);
    }
});

// Add Collaborator (POST)
app.post('/add-collaborator/:id', requireAuth, async (req, res) => {
    const { userid } = req.body;

    try {
        const idea = await knex('idea_details')
            .where({ ideaid: req.params.id })
            .first();

        // Only owner can add collaborators
        if (idea && idea.userid === req.session.userId) {
            await knex('collaborations')
                .insert({
                    ideaid: req.params.id,
                    userid: parseInt(userid)
                })
                .onConflict(['ideaid', 'userid'])
                .ignore();
        }

        res.redirect(`/edit-idea/${req.params.id}`);
    } catch (err) {
        console.error('Add collaborator error:', err);
        res.redirect(`/edit-idea/${req.params.id}`);
    }
});

// Remove Collaborator (POST)
app.post('/remove-collaborator/:ideaid/:userid', requireAuth, async (req, res) => {
    try {
        const idea = await knex('idea_details')
            .where({ ideaid: req.params.ideaid })
            .first();

        // Only owner can remove collaborators
        if (idea && idea.userid === req.session.userId) {
            await knex('collaborations')
                .where({
                    ideaid: req.params.ideaid,
                    userid: req.params.userid
                })
                .del();
        }

        res.redirect(`/edit-idea/${req.params.ideaid}`);
    } catch (err) {
        console.error('Remove collaborator error:', err);
        res.redirect(`/edit-idea/${req.params.ideaid}`);
    }
});

// Delete Idea (POST)
app.post('/delete-idea/:id', requireAuth, async (req, res) => {
    try {
        const idea = await knex('idea_details')
            .where({ ideaid: req.params.id })
            .first();

        // Only owner can delete
        if (idea && idea.userid === req.session.userId) {
            await knex('idea_details')
                .where({ ideaid: req.params.id })
                .del();
        }

        res.redirect('/view-ideas');
    } catch (err) {
        console.error('Delete idea error:', err);
        res.redirect('/view-ideas');
    }
});

// Start server
app.listen(port, () => {
    console.log(`Business Ideas Tracker running on port ${port}`);
});