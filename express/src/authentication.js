import express from 'express'
import session from 'express-session'
import { User, Role, Salt, Verification } from '../utils/database/models.js'
import passport from 'passport'
import LocalStrategy from 'passport-local'
import crypto from 'crypto'
import HttpStatusCode from '../utils/httpStatusCode.js';
import nodemailer from 'nodemailer'
import dotenv from 'dotenv'
import cors from 'cors'
import { checkBodyNull } from '../utils/util.js'
import { s3Client } from '../utils/util.js'
import fs from 'fs'

const router = express.Router();
dotenv.config();
router.use(cors({
    credentials: true,
    origin: true,
}));


passport.serializeUser(function (user, callback) {
    process.nextTick(function () {
        return callback(null, {
            id: user.id,
            email: user.email,
            name: user.name,
            profileImageUrl: user.profileImageUrl,
            role: user.role,
        });
    });
});

passport.deserializeUser(function (user, callback) {
    process.nextTick(function () {
        return callback(null, user);
    });
});

passport.use(new LocalStrategy({
    usernameField: 'email',
    passwordField: "password",
    session: true,
}, async function verify(email, password, callback) {
    const accounts = await User.findAll({
        where: {
            email: email,
        },
        limit: 1,
        raw: true,
    }).catch(err => {
        return callback(err);
    })
    if (!accounts || accounts.length == 0) {
        return callback(null, false, { message: "Incorrect email." })
    }
    const user = accounts[0];
    const salt = await Salt.findOne({
        where: {
            user: user.id,
        },
        raw: true,
    })
    if (!salt) {
        return callback(null, false, { message: "Failed to retrieve salt" })
    }
    if (!user.password) {
        return callback(null, false, { message: "User needs password migration from Firebase" })
    }

    crypto.pbkdf2(password, salt.salt, 1250, 64, 'sha512', (err, hashedPassword) => {
        if (err) {
            return callback(null, false, { message: err })
        }
        if (crypto.timingSafeEqual(Buffer.from(user.password, "base64"), hashedPassword)) {
            return callback(null, user)
        }
        else {
            return callback(null, false, { message: "Incorrect password" })
        }
    })
}));



function createSalt() {
    return crypto.randomBytes(2048).toString("base64");
}

router.post("/signin",
    async (req, res, next) => {
        if (checkBodyNull(req)) {
            res.status(HttpStatusCode.NO_CONTENT).send("No body attached")
            return;
        }

        const user = await User.findOne({
            where: {
                email: req.body.email,
            },
            raw: true,
        })
        if (user == null) {
            res.status(HttpStatusCode.BAD_REQUEST).send("User Not Found")
        }
        else if (!user.password) {
            res.status(HttpStatusCode.NOT_IMPLEMENTED).send("Need firebase password update")
        }
        else {
            next();
        }
    },
    passport.authenticate('local', { failureRedirect: "/signin", failureMessage: true }),
    async (req, res) => {
        const user = await User.findOne({
            where: {
                email: req.body.email,
            },
            attributes: { exclude: ["createdAt", "updatedAt", "id",] },
            raw: true,
        })
        if (user === null) {
            res.status(HttpStatusCode.BAD_REQUEST).send("No Such User Found")
            return;
        }
        const role = await Role.findByPk(user.role);
        user.role = role.name;
        const otherCheckStatus = otherChecks(user);
        if (!otherCheckStatus.status) {
            req.logout(err => {
                if (err) {
                    return;
                }
                res.status(HttpStatusCode.BAD_REQUEST).send(otherCheckStatus.message)
            });
        }
        else {
            const userdata = {
                name: user.name,
                email: user.email,
                profileImageUrl: user.profileImageUrl,
                enrolledYear: user.enrolledYear,
                major: user.major,
                yearOfBirth: user.yearOfBirth,
                role: user.role,
                gender: user.gender,
            }
            res.status(HttpStatusCode.OK).send(userdata);
        }
    },
)

function otherChecks(user) {
    if (!user.emailVerified) {
        return {
            status: false,
            "message": "Email Not Verified"
        }
    }
    if (!user.verified) {
        return {
            status: false,
            "message": "Account Not Verified"
        }
    }
    return {
        status: true,
        "message": "",
    }
}

router.post("/signout", (req, res) => {
    req.logout((err) => {
        if (err) {
            return req(err);
        }
        res.redirect("/#/");
    })
})

router.post("/signup", async (req, res) => {
    if (checkBodyNull(req)) {
        res.status(HttpStatusCode.NO_CONTENT).send("No body attached")
        return;
    }

    const userdata = req.body;
    const role = req.body.role;

    //FIND ASSIGNED ROLE
    const roleObject = await Role.findOne({
        where: {
            name: role,
        },
        raw: true,
    })

    //CREATE NEW USER
    const newUser = await User.create({
        name: userdata.name,
        yearOfBirth: userdata.yob,
        gender: userdata.gender,
        enrolledYear: userdata.enrolledYear,
        email: userdata.email,
        major: userdata.major,
        kakaoTalkId: userdata.kakaoTalkId,
        verified: userdata.verified,
        emailVerified: false,
        profileImageUrl: userdata.profileImageUrl,
        role: roleObject.id,
    })

    //SEND VERIFICATION EMAIL
    const emailSuccess = await sendVerificationEmail(userdata.email, newUser.id);
    if (!emailSuccess) {
        await newUser.destroy();
        res.status(HttpStatusCode.NOT_ACCEPTABLE).send("Invalid email is used.")
        return;
    }

    //CREATE & REGISTER SALT
    const salt = createSalt();
    await Salt.create({
        salt: salt,
        user: newUser.id,
    })

    //CREATE AND SAVE HASHED PASSWORD
    crypto.pbkdf2(userdata.password, salt, 1250, 64, 'sha512', async (err, hashedPassword) => {
        if (err) {
            console.log(err);
            res.status(HttpStatusCode.EXPECTATION_FAILED).send();
            return;
        }
        await newUser.update({
            password: hashedPassword.toString('base64')
        })
    })

    //REGISTER VERIFICATION FILE
    if (userdata.verificationFileUrl) {
        await Verification.create({
            fileUrl: userdata.verificationFileUrl,
            user: newUser.id,
        })
    }

    //SEND RESPONSE
    res.status(HttpStatusCode.OK).send("Signup Successful")
})

router.get("/sendVerificationEmail/:email", async (req, res) => {
    if (isNotLoggedIn(req)) {
        res.status(HttpStatusCode.UNAUTHORIZED)
        res.send("Not Logged In");
        return;
    }
    const role = await Role.findByPk(req.user.role)
    if (role.name != "Admin") {
        res.status(HttpStatusCode.UNAUTHORIZED)
        res.send("Not Logged In");
        return;
    }
    const user = await User.findOne({
        where: {
            email: req.params.email,
        },
        raw: true,
    })
    if (user == null) {
        res.status(HttpStatusCode.NO_CONTENT).send("No such user exists");
        return;
    }
    const sent = await sendVerificationEmail(req.params.email, user.id);
    if (sent) {
        res.status(HttpStatusCode.OK).send("Verification Email Successfully Sent")
        return;
    }
    else {
        res.status(HttpStatusCode.EXPECTATION_FAILED).send("Error while sending verification email")
        return;
    }
})

router.post("/updateAuthPassword", async (req, res) => {
    if (checkBodyNull(req)) {
        res.status(HttpStatusCode.NO_CONTENT).send("No body attached")
        return;
    }

    const user = await User.findOne({
        where: {
            email: req.body.email,
        },
    })

    if (!user) {
        res.status(HttpStatusCode.NOT_FOUND).send();
        return;
    }

    const salt = createSalt();
    await Salt.create({
        salt: salt,
        user: user.id,
    })

    crypto.pbkdf2(req.body.password, salt, 1250, 64, 'sha512', async (err, hashedPassword) => {
        if (err) {
            console.log(err);
            res.status(HttpStatusCode.EXPECTATION_FAILED).send();
            return;
        }
        const updatedUser = await user.update({
            password: hashedPassword.toString('base64')
        })
        const userRole = await Role.findByPk(updatedUser.role)
        const userdata = {
            name: updatedUser.name,
            email: updatedUser.email,
            profileImageUrl: updatedUser.profileImageUrl,
            enrolledYear: updatedUser.enrolledYear,
            major: updatedUser.major,
            yearOfBirth: updatedUser.yearOfBirth,
            role: userRole.name,
            gender: updatedUser.gender,
        }
        res.status(HttpStatusCode.OK).send(userdata);
    })
})

router.post("/updatePassword", async (req, res) => {
    if (isNotLoggedIn(req)) {
        res.status(HttpStatusCode.BAD_REQUEST).send("You are not logged in as this user")
        return;
    }
    const user = await User.findOne({
        where: {
            email: req.user.email
        }
    })

    const salt = await Salt.findOne({
        where: {
            user: req.user.id,
        }
    })

    crypto.pbkdf2(req.body.prevPassword, salt.salt, 1250, 64, 'sha512', async (err, hashedPassword) => {
        if (err) {
            console.log(err);
            res.status(HttpStatusCode.EXPECTATION_FAILED).send();
            return;
        }
        else if (hashedPassword.toString('base64') == user.password) {
            const newSalt = createSalt();
            const newSaltObject = await salt.update({
                salt: newSalt,
            })

            crypto.pbkdf2(req.body.password, newSaltObject.salt, 1250, 64, 'sha512', async (err, hashedPassword) => {
                if (err) {
                    console.log(err);
                    res.status(HttpStatusCode.EXPECTATION_FAILED).send();
                    return;
                }
                const updatedUser = await user.update({
                    password: hashedPassword.toString('base64')
                })
                res.status(HttpStatusCode.OK).send();
            })
        }
        else {
            res.status(HttpStatusCode.UNAUTHORIZED).send();
        }
    })
})

router.post("/uploadVerificationDocument/:fileName", async (req, res) => {
    if (!req.files) {
        res.status(HttpStatusCode.BAD_REQUEST).send("No file attached")
        return;
    }
    
    try {
        const filePath = req.files.file.tempFilePath;
        const blob = fs.readFileSync(filePath);
        const key = "verifications/" + req.params.fileName
        const uploadedFile = await s3Client.upload({
            Bucket: "nuskusa-storage",
            Key: key,
            Body: blob,
            ACL: "public-read"
        }).promise()

        const result = {
            url: uploadedFile.Location
        }

        res.status(HttpStatusCode.OK).send(result);
    }
    catch(err) {
        console.log(err)
        res.status(HttpStatusCode.EXPECTATION_FAILED).send("Error has occurred")
    }
})

router.get("/getToVerify", async (req, res) => {
    if (isNotLoggedIn(req)) {
        res.status(HttpStatusCode.BAD_REQUEST).send("You are not logged in as this user")
        return;
    }
    const currentRole = await Role.findByPk(req.user.role);
    if (currentRole.name != "Admin") {
        res.status(HttpStatusCode.UNAUTHORIZED).send();
        return;
    }
    const toVerify = await Verification.findAll({
        order: [["updatedAt", "DESC"]],
        raw: true,
    })
    const promises = [];
    for (let i = 0; i < toVerify.length; i++) {
        promises.push(new Promise(async (resolve, reject) => {
            const user = await User.findOne({
                where: {
                    id: toVerify[i].user,
                },
                attributes: ["name", "email", "gender", "major", "kakaoTalkId", "role"],
            })
            const role = await Role.findByPk(user.role);
            user.role = role.name;
            toVerify[i].user = user;
            resolve(true);
        }))
    }
    Promise.all(promises).then(() => {
        res.status(HttpStatusCode.OK).send(toVerify);
        return;
    })
})

router.post("/verifyUser", async (req, res) => {
    if (isNotLoggedIn(req)) {
        res.status(HttpStatusCode.BAD_REQUEST).send("You are not logged in as this user")
        return;
    }
    if (checkBodyNull(req)) {
        res.status(HttpStatusCode.NO_CONTENT).send("No body attached")
        return;
    }

    const currentRole = await Role.findByPk(req.user.role);
    if (currentRole.name != "Admin") {
        res.status(HttpStatusCode.UNAUTHORIZED).send();
        return;
    }
    const verification = await Verification.findByPk(req.body.verificationId);
    const verifiedUser = await User.findOne({
        where: {
            id: verification.user,
        },
    })
    if (!verifiedUser) {
        res.status(HttpStatusCode.BAD_REQUEST).send();
        return;
    }
    await verifiedUser.update({
        verified: true,
    })
    await verification.destroy();
    emailAlertVerification(verifiedUser.email)
    res.status(HttpStatusCode.OK).send();
})

router.post("/declineUser", async (req, res) => {
    if (isNotLoggedIn(req)) {
        res.status(HttpStatusCode.BAD_REQUEST).send("You are not logged in as this user")
        return;
    }
    if (checkBodyNull(req)) {
        res.status(HttpStatusCode.NO_CONTENT).send("No body attached")
        return;
    }

    const currentRole = await Role.findByPk(req.user.role);
    if (currentRole.name != "Admin") {
        res.status(HttpStatusCode.UNAUTHORIZED).send();
        return;
    }
    const verification = await Verification.findOne({
        where: {
            id: req.body.verificationId
        }
    })
    if (!verification) {
        res.status(HttpStatusCode.BAD_REQUEST).send();
        return;
    }
    const deniedUser = await User.findOne({
        where: {
            id: verification.user,
        },
    })
    if (!deniedUser) {
        res.status(HttpStatusCode.BAD_REQUEST).send();
        return;
    }
    await verification.destroy();
    await emailAlertDenial(deniedUser.email, req.body.denialMessage)
    res.status(HttpStatusCode.OK).send();
})

router.get("/emailVerify/:userId", async (req, res) => {
    const user = await User.findByPk(req.params.userId)
    if (user == null) {
        res.status(HttpStatusCode.NOT_FOUND).send("User Not Found")
        return
    }
    const updated = await user.update({
        emailVerified: true,
    })
    res.status(200).send("User's email is successfully verified.")
    return;
})

router.post("/findPassword/", async (req, res) => {
    if (checkBodyNull(req)) {
        res.status(HttpStatusCode.NO_CONTENT).send("No body attached")
        return;
    }

    const user = await User.findOne({
        where: {
            email: req.body.email,
        }
    })
    if (user == null) {
        res.status(HttpStatusCode.NOT_FOUND).send("No such user")
        return;
    }
    if (user.name != req.body.name && user.yearOfBirth != req.body.yearOfBirth) {
        res.status(HttpStatusCode.UNAUTHORIZED).send("Information mismatch")
        return;
    }
    const salt = await Salt.findOne({
        where: {
            user: user.id
        }
    })
    const tempPassword = generateTempPassword();
    const hashedTempPassword = crypto.createHash('sha512').update(tempPassword).digest('hex')
    crypto.pbkdf2(hashedTempPassword, salt.salt, 1250, 64, 'sha512', async (err, hashedPassword) => {
        if (err) {
            console.log(err);
            res.status(HttpStatusCode.EXPECTATION_FAILED).send();
            return;
        }
        const updatedUser = await user.update({
            password: hashedPassword.toString('base64')
        })
        const successful = await sendPasswordResetEmail(req.body.email, tempPassword)
        if (!successful) {
            res.status(HttpStatusCode.EXPECTATION_FAILED).send("Temporary Password Email Sending Failed");
        } else {
            res.status(HttpStatusCode.OK).send("Email with temporary password successfully sent.");
        }
    })
})

router.get("/removeAccount", async (req, res) => {
    if (isNotLoggedIn(req)) {
        res.status(HttpStatusCode.BAD_REQUEST.send("You are not logged in as this user"))
        return;
    }
    if (checkBodyNull(req)) {
        res.status(HttpStatusCode.NO_CONTENT).send("No body attached")
        return;
    }

    const user = await User.findOne({
        where: {
            email: req.body.email,
        }
    })
    await user.destroy();
    res.status(HttpStatusCode.OK).send("Deleted Successfully")
})

function generateTempPassword() {
    return Math.random().toString(36).slice(-8);
}

function sendPasswordResetEmail(email, newTempPassword) {
    return new Promise((resolve, reject) => {
        const transporter = nodemailer.createTransport({
            service: "gmail",//process.env.EMAIL_SERVICE,
            auth: {
                user: "nuskusa@gmail.com",//process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASSWORD,
            },
            from: "nuskusa@outlook.com"
        })

        const options = {
            from: "NUS ????????? <nuskusa@gmail.com>",//process.env.EMAIL_SENDER,
            to: email,
            subject: "NUS ????????? ???????????? ???????????? ????????? ??????",
            text: `???????????????, NUS ??????????????????.\n\n ???????????? ???????????? ?????????????????????. \n\n ????????? ?????? ??????????????? ????????? ????????????. ?????? ??? ?????????????????????, ??????????????? ?????? ?????????????????? ????????????. \n\n ?????? ????????? ???????????? ?????? ???????????? ?????? NUS????????? (nuskusa@gmail.com / ????????? nus_ks) ??? ?????? ??????????????????. \n\n ?????? ????????????: ${newTempPassword} \n\n ???????????????. \n\n NUS ????????? ??????.`,
        }

        transporter.sendMail(options, (error, info) => {
            console.log(error)
            console.log(info)
            if (error) {
                resolve(false);
            }
            else {
                resolve(true);
            }
        })
    })
}

function sendVerificationEmail(email, userId) {
    return new Promise((resolve, reject) => {
        const transporter = nodemailer.createTransport({
            service: "gmail",//process.env.EMAIL_SERVICE,
            auth: {
                user: "nuskusa@gmail.com",//process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASSWORD,
            },
            from: "nuskusa@gmail.com"
        })

        const link = "https://nuskoreasociety.org/auth/verifyEmail/" + userId

        const options = {
            from: "NUS ????????? <nuskusa@gmail.com>",//process.env.EMAIL_SENDER,
            to: email,
            subject: "NUS ????????? ???????????? ????????? ?????? ??????",
            text: `???????????????, NUS ??????????????????.\n\n ????????? ??????????????? ?????????????????? ???????????????. \n\n ????????? ????????? ??????????????? ?????? ???????????? ????????? ??????????????? ???????????? ?????? ????????? ?????????????????????. \n\n ${link} \n\n ???????????????. \n\n NUS ????????? ??????.`,
        }

        transporter.sendMail(options, (error, info) => {
            console.log(info)
            console.log(error)
            if (info.rejected.length > 0) {
                resolve(false);
            }
            else {
                resolve(true);
            }
        })
    })
}

async function emailAlertDenial(email, denialMessage) {
    const transporter = nodemailer.createTransport({
        service: "gmail",//process.env.EMAIL_SERVICE,
        auth: {
            user: "nuskusa@gmail.com",//process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
        },
        from: "nuskusa@gmail.com"
    })

    const options = {
        from: "NUS ????????? <nuskusa@gmail.com>",//process.env.EMAIL_SENDER,
        to: email,
        subject: "NUS ????????? ???????????? ?????? ?????? ??????",
        text: `???????????????, NUS ??????????????????.\n\n ????????? ??????????????? ?????????????????? ???????????????. \n\n ???????????? ????????? ????????? ???????????? ????????? ????????????. \n\n ????????? ?????? ????????? ??????????????? ????????? ??????????????????. \n\n ??? ?????? ??? ??? ????????? ???????????????. \n\n ???????????????. \n\n NUS ????????? ??????.`,
    }

    transporter.sendMail(options, (error, info) => {
        if (info.rejected.length > 0) {
            resolve(false);
        }
        else {
            resolve(true);
        }
    })
}

async function emailAlertVerification(email) {
    const transporter = nodemailer.createTransport({
        service: "gmail",//process.env.EMAIL_SERVICE,
        auth: {
            user: "nuskusa@gmail.com",//process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
        },
        from: "nuskusa@gmail.com"
    })

    const options = {
        from: "NUS ????????? <nuskusa@gmail.com>",//process.env.EMAIL_SENDER,
        to: email,
        subject: "NUS ????????? ???????????? ????????? ?????? ??????",
        text: `???????????????, NUS ??????????????????.\n\n ????????? ??????????????? ?????????????????? ???????????????. \n\n ???????????? ????????? ????????? ?????????????????????. \n\n ?????? ?????? ??????????????? ???????????? ?????? ??????????????? ???????????????!. \n\n ???????????????. \n\n NUS ????????? ??????.`,
    }

    transporter.sendMail(options, (error, info) => {
        if (info.rejected.length > 0) {
            resolve(false);
        }
        else {
            resolve(true);
        }
    })
}

function isNotLoggedIn(request) {
    if (!request || !request.user || !request.user.email) {
        return true;
    }
    return false;
}

export default router;
export { isNotLoggedIn, createSalt, sendVerificationEmail };