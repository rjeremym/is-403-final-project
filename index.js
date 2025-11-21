// Business Ideas Tracker
// A web app that allows users to register, login, create business ideas,
// collaborate with others, and search/filter their ideas

// Load environment variables from .env file into memory
require('dotenv').config();

const express = require("express");
const session = require("express-session");
let path = require("path");

let app = express();

// Use EJS for the web pages - requires a views folder and all files are .ejs
app.set("view engine", "ejs");

// process.env.PORT is when you deploy and 3000 is for test
const port = process.env.PORT || 3000;

/* Session middleware - handles user authentication state
Secret is used to sign session cookies to prevent tampering
resave: false - only save session if modified
saveUninitialized: false - only create session when data is stored
*/
app.use(
    session({
        secret: process.env.SESSION_SECRET || 'fallback-secret-key-change-in-production',
        resave: false,
        saveUninitialized: false,
    })
);

// Knex library to connect to PostgreSQL database and run SQL queries
const knex = require("knex")({
    client: "pg",
    connection: {
        host: process.env.RDS_HOST || "localhost",
        user: process.env.RDS_USER || "postgres",
        password: process.env.RDS_PASSWORD || "admin",
        database: process.env.RDS_NAME || "business_ideas",
        port: process.env.RDS_PORT || 5432,
        ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : false
    }
});

// Middleware to parse form data from POST requests
app.use(express.urlencoded({ extended: true }));

// Serve static files (CSS, images, etc.) from the public folder
app.use(express.static('public'));

// Global middleware to make username available in all EJS templates
app.use((req, res, next) => {
    res.locals.username = req.session.username || null;
    res.locals.userId = req.session.userId || null;
    next();
});

// Global authentication middleware - runs on EVERY request
app.use((req, res, next) => {
    // Public routes that don't require authentication
    const publicRoutes = ['/', '/login', '/register', '/logout'];
    
    if (publicRoutes.includes(req.path)) {
        return next();
    }
    
    // Check if user is logged in for all other routes
    if (req.session.isLoggedIn) {
        next(); // User is logged in, continue to route
    } else {
        res.render("login", { error_message: "Please log in to access this page" });
    }
});

// ==================== PUBLIC ROUTES ====================

// Landing/Home page route
app.get("/", (req, res) => {
    if (req.session.isLoggedIn) {
        res.render("index");
    } else {
        res.render("landing");
    }
});

// Show login page
app.get("/login", (req, res) => {
    if (req.session.isLoggedIn) {
        res.redirect("/");
    } else {
        res.render("login", { error_message: "" });
    }
});

// Handle login form submission
app.post("/login", (req, res) => {
    let sUsername = req.body.username;
    let sPassword = req.body.password;

    // Query database to find matching username and password
    knex.select("userid", "username", "passwordhash", "email", "firstname", "lastname")
        .from('security')
        .where("username", sUsername)
        .andWhere("passwordhash", sPassword) // In production, use bcrypt.compare()
        .then(users => {
            // Check if a user was found with matching credentials
            if (users.length > 0) {
                // Set session variables to track logged-in user
                req.session.isLoggedIn = true;
                req.session.userId = users[0].userid;
                req.session.username = users[0].username;
                req.session.email = users[0].email;
                req.session.firstName = users[0].firstname;
                req.session.lastName = users[0].lastname;
                res.redirect("/");
            } else {
                // No matching user found
                res.render("login", { error_message: "Invalid username or password" });
            }
        })
        .catch(err => {
            console.error("Login error:", err);
            res.render("login", { error_message: "Login error. Please try again." });
        });
});

// Show registration page
app.get("/register", (req, res) => {
    if (req.session.isLoggedIn) {
        res.redirect("/");
    } else {
        res.render("register", { error_message: "" });
    }
});

// Handle registration form submission
app.post("/register", (req, res) => {
    const { username, password, email, firstname, lastname } = req.body;

    // Validate required fields
    if (!username || !password || !email || !firstname || !lastname) {
        return res.render("register", { 
            error_message: "All fields are required" 
        });
    }

    // Check if username already exists
    knex.select("username")
        .from("security")
        .where("username", username)
        .then(existingUsers => {
            if (existingUsers.length > 0) {
                return res.render("register", { 
                    error_message: "Username already exists. Please choose another." 
                });
            }

            // Create new user object
            const newUser = {
                username,
                passwordhash: password, // In production, use bcrypt.hash()
                email,
                firstname,
                lastname,
                accountcreated: new Date(),
                lastlogin: null,
                failedattempts: 0
            };

            // Insert new user into database
            knex("security")
                .insert(newUser)
                .then(() => {
                    // Registration successful, redirect to login
                    res.render("login", { 
                        error_message: "Registration successful! Please log in." 
                    });
                })
                .catch(dbErr => {
                    console.error("Error creating user:", dbErr.message);
                    res.render("register", { 
                        error_message: "Unable to create account. Please try again." 
                    });
                });
        })
        .catch(err => {
            console.error("Error checking username:", err.message);
            res.render("register", { 
                error_message: "Registration error. Please try again." 
            });
        });
});

// Logout route
app.get("/logout", (req, res) => {
    // Destroy the session object and redirect to landing page
    req.session.destroy((err) => {
        if (err) {
            console.log("Logout error:", err);
        }
        res.redirect("/");
    });
});

// ==================== IDEA ROUTES ====================

// Display all ideas (owned by user or collaborated on)
app.get("/ideas", (req, res) => {
    const userId = req.session.userId;
    
    // Get search/filter parameters from query string
    const searchName = req.query.searchName || '';
    const searchMarketing = req.query.searchMarketing || '';
    const searchCustomer = req.query.searchCustomer || '';
    const minCost = req.query.minCost || '';
    const maxCost = req.query.maxCost || '';
    const minPotential = req.query.minPotential || '';

    // Build complex query to get ideas user owns or collaborates on
    let query = knex('idea_details as id')
        .leftJoin('security as s', 'id.userid', 's.userid')
        .leftJoin('collaborations as c', 'id.ideaid', 'c.ideaid')
        .select(
            'id.ideaid',
            'id.ideaname',
            'id.ideadescription',
            'id.marketingstrategy',
            'id.targetcustomer',
            'id.estimatedcost',
            'id.timeline',
            'id.potential',
            'id.userid as ownerid',
            's.username as ownername',
            's.firstname as ownerfirstname',
            's.lastname as ownerlastname'
        )
        .where(function() {
            this.where('id.userid', userId)  // Ideas user owns
                .orWhere('c.userid', userId);  // Ideas user collaborates on
        })
        .groupBy('id.ideaid', 's.userid');

    // Apply search filters if provided
    if (searchName) {
        query = query.andWhere('id.ideaname', 'ilike', `%${searchName}%`);
    }
    if (searchMarketing) {
        query = query.andWhere('id.marketingstrategy', 'ilike', `%${searchMarketing}%`);
    }
    if (searchCustomer) {
        query = query.andWhere('id.targetcustomer', 'ilike', `%${searchCustomer}%`);
    }
    if (minCost) {
        query = query.andWhere('id.estimatedcost', '>=', parseFloat(minCost));
    }
    if (maxCost) {
        query = query.andWhere('id.estimatedcost', '<=', parseFloat(maxCost));
    }
    if (minPotential) {
        query = query.andWhere('id.potential', '>=', parseInt(minPotential));
    }

    query.orderBy('id.ideaid', 'desc')
        .then(ideas => {
            // For each idea, get the list of collaborators
            const ideaPromises = ideas.map(idea => {
                return knex('collaborations as c')
                    .join('security as s', 'c.userid', 's.userid')
                    .select('s.userid', 's.username', 's.firstname', 's.lastname')
                    .where('c.ideaid', idea.ideaid)
                    .then(collaborators => {
                        idea.collaborators = collaborators;
                        return idea;
                    });
            });

            return Promise.all(ideaPromises);
        })
        .then(ideasWithCollaborators => {
            res.render("viewIdeas", {
                ideas: ideasWithCollaborators,
                searchParams: {
                    searchName,
                    searchMarketing,
                    searchCustomer,
                    minCost,
                    maxCost,
                    minPotential
                }
            });
        })
        .catch(err => {
            console.error("Error fetching ideas:", err.message);
            res.render("viewIdeas", {
                ideas: [],
                searchParams: {},
                error_message: `Database error: ${err.message}`
            });
        });
});

// Show add idea page
app.get("/addIdea", (req, res) => {
    res.render("addIdea", { error_message: "" });
});

// Handle add idea form submission
app.post("/addIdea", (req, res) => {
    const { ideaname, ideadescription, marketingstrategy, targetcustomer, 
            estimatedcost, timeline, potential } = req.body;

    // Validate required fields
    if (!ideaname || !ideadescription) {
        return res.render("addIdea", { 
            error_message: "Idea name and description are required" 
        });
    }

    // Create new idea object
    const newIdea = {
        userid: req.session.userId,
        ideaname,
        ideadescription,
        marketingstrategy: marketingstrategy || null,
        targetcustomer: targetcustomer || null,
        estimatedcost: estimatedcost ? parseFloat(estimatedcost) : null,
        timeline: timeline || null,
        potential: potential ? parseInt(potential) : null
    };

    // Insert idea into database
    knex("idea_details")
        .insert(newIdea)
        .then(() => {
            res.redirect("/ideas");
        })
        .catch(dbErr => {
            console.error("Error inserting idea:", dbErr.message);
            res.render("addIdea", { 
                error_message: "Unable to save idea. Please try again." 
            });
        });
});

// Show edit idea page
app.get("/editIdea/:id", (req, res) => {
    const ideaId = req.params.id;
    const userId = req.session.userId;

    // Get idea details
    knex("idea_details")
        .where({ ideaid: ideaId })
        .first()
        .then(idea => {
            if (!idea) {
                return res.redirect("/ideas");
            }

            // Check if user owns the idea or is a collaborator
            knex('collaborations')
                .where({ ideaid: ideaId, userid: userId })
                .first()
                .then(collaboration => {
                    const isOwner = idea.userid === userId;
                    const isCollaborator = !!collaboration;

                    if (!isOwner && !isCollaborator) {
                        return res.redirect("/ideas");
                    }

                    // Get list of collaborators for this idea
                    knex('collaborations as c')
                        .join('security as s', 'c.userid', 's.userid')
                        .select('c.collaborationid', 's.userid', 's.username', 
                                's.firstname', 's.lastname')
                        .where('c.ideaid', ideaId)
                        .then(collaborators => {
                            // Get list of all users (for adding collaborators)
                            knex('security')
                                .select('userid', 'username', 'firstname', 'lastname')
                                .whereNot('userid', idea.userid) // Exclude owner
                                .whereNotIn('userid', collaborators.map(c => c.userid)) // Exclude existing collaborators
                                .then(availableUsers => {
                                    res.render("editIdea", {
                                        idea,
                                        collaborators,
                                        availableUsers,
                                        isOwner,
                                        error_message: ""
                                    });
                                });
                        });
                });
        })
        .catch(err => {
            console.error("Error fetching idea:", err.message);
            res.redirect("/ideas");
        });
});

// Handle edit idea form submission
app.post("/editIdea/:id", (req, res) => {
    const ideaId = req.params.id;
    const userId = req.session.userId;
    const { ideaname, ideadescription, marketingstrategy, targetcustomer, 
            estimatedcost, timeline, potential } = req.body;

    // Validate required fields
    if (!ideaname || !ideadescription) {
        return res.redirect(`/editIdea/${ideaId}`);
    }

    // Check if user has permission to edit (owner or collaborator)
    knex("idea_details")
        .where({ ideaid: ideaId })
        .first()
        .then(idea => {
            if (!idea) {
                return res.redirect("/ideas");
            }

            knex('collaborations')
                .where({ ideaid: ideaId, userid: userId })
                .first()
                .then(collaboration => {
                    const isOwner = idea.userid === userId;
                    const isCollaborator = !!collaboration;

                    if (!isOwner && !isCollaborator) {
                        return res.redirect("/ideas");
                    }

                    // Update idea
                    const updatedIdea = {
                        ideaname,
                        ideadescription,
                        marketingstrategy: marketingstrategy || null,
                        targetcustomer: targetcustomer || null,
                        estimatedcost: estimatedcost ? parseFloat(estimatedcost) : null,
                        timeline: timeline || null,
                        potential: potential ? parseInt(potential) : null
                    };

                    knex("idea_details")
                        .where({ ideaid: ideaId })
                        .update(updatedIdea)
                        .then(() => {
                            res.redirect("/ideas");
                        })
                        .catch(err => {
                            console.error("Error updating idea:", err.message);
                            res.redirect(`/editIdea/${ideaId}`);
                        });
                });
        })
        .catch(err => {
            console.error("Error checking permissions:", err.message);
            res.redirect("/ideas");
        });
});

// Delete idea (owner only)
app.post("/deleteIdea/:id", (req, res) => {
    const ideaId = req.params.id;
    const userId = req.session.userId;

    // Check if user is the owner
    knex("idea_details")
        .where({ ideaid: ideaId })
        .first()
        .then(idea => {
            if (!idea || idea.userid !== userId) {
                // Not the owner, can't delete
                return res.redirect("/ideas");
            }

            // Delete all collaborations first (foreign key constraint)
            knex("collaborations")
                .where({ ideaid: ideaId })
                .del()
                .then(() => {
                    // Then delete the idea
                    return knex("idea_details")
                        .where({ ideaid: ideaId })
                        .del();
                })
                .then(() => {
                    res.redirect("/ideas");
                })
                .catch(err => {
                    console.error("Error deleting idea:", err.message);
                    res.redirect("/ideas");
                });
        })
        .catch(err => {
            console.error("Error checking ownership:", err.message);
            res.redirect("/ideas");
        });
});

// ==================== COLLABORATION ROUTES ====================

// Add collaborator to an idea
app.post("/addCollaborator/:id", (req, res) => {
    const ideaId = req.params.id;
    const userId = req.session.userId;
    const collaboratorId = req.body.collaboratorId;

    // Check if user is the owner
    knex("idea_details")
        .where({ ideaid: ideaId })
        .first()
        .then(idea => {
            if (!idea || idea.userid !== userId) {
                // Not the owner, can't add collaborators
                return res.redirect(`/editIdea/${ideaId}`);
            }

            // Check if collaboration already exists
            knex("collaborations")
                .where({ ideaid: ideaId, userid: collaboratorId })
                .first()
                .then(existing => {
                    if (existing) {
                        return res.redirect(`/editIdea/${ideaId}`);
                    }

                    // Add collaboration
                    knex("collaborations")
                        .insert({ ideaid: ideaId, userid: collaboratorId })
                        .then(() => {
                            res.redirect(`/editIdea/${ideaId}`);
                        })
                        .catch(err => {
                            console.error("Error adding collaborator:", err.message);
                            res.redirect(`/editIdea/${ideaId}`);
                        });
                });
        })
        .catch(err => {
            console.error("Error checking ownership:", err.message);
            res.redirect(`/editIdea/${ideaId}`);
        });
});

// Remove collaborator from an idea (owner only)
app.post("/removeCollaborator/:collaborationId", (req, res) => {
    const collaborationId = req.params.collaborationId;
    const userId = req.session.userId;

    // Get collaboration details
    knex("collaborations")
        .where({ collaborationid: collaborationId })
        .first()
        .then(collaboration => {
            if (!collaboration) {
                return res.redirect("/ideas");
            }

            // Check if user is the owner of the idea
            knex("idea_details")
                .where({ ideaid: collaboration.ideaid })
                .first()
                .then(idea => {
                    if (!idea || idea.userid !== userId) {
                        // Not the owner, can't remove collaborators
                        return res.redirect(`/editIdea/${collaboration.ideaid}`);
                    }

                    // Remove collaboration
                    knex("collaborations")
                        .where({ collaborationid: collaborationId })
                        .del()
                        .then(() => {
                            res.redirect(`/editIdea/${collaboration.ideaid}`);
                        })
                        .catch(err => {
                            console.error("Error removing collaborator:", err.message);
                            res.redirect(`/editIdea/${collaboration.ideaid}`);
                        });
                });
        })
        .catch(err => {
            console.error("Error fetching collaboration:", err.message);
            res.redirect("/ideas");
        });
});

// Leave collaboration (collaborator only)
app.post("/leaveCollaboration/:id", (req, res) => {
    const ideaId = req.params.id;
    const userId = req.session.userId;

    // Remove the collaboration for this user
    knex("collaborations")
        .where({ ideaid: ideaId, userid: userId })
        .del()
        .then(() => {
            res.redirect("/ideas");
        })
        .catch(err => {
            console.error("Error leaving collaboration:", err.message);
            res.redirect("/ideas");
        });
});

// ==================== START SERVER ====================

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});