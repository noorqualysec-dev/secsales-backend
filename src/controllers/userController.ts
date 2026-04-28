import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import { rtdb } from "../config/firebase.js";
import generateToken from "../utils/generateToken.js";

const USERS_PATH = "users";

export const createUser = async (req: Request, res: Response) => {
    try {
        console.log("➡️ POST /api/users - Incoming Body:");
        const { name, email, password, role } = req.body;

        if (!name || !email || !password) {
            res.status(400).json({ success: false, message: "Please provide all required fields" });
            return;
        }

        if (role === "manager") {
            res.status(403).json({ success: false, message: "Manager accounts can only be assigned by admin" });
            return;
        }

        // 1. Check if user already exists
        const snapshot = await rtdb.ref(USERS_PATH).orderByChild("email").equalTo(email).once("value");

        if (snapshot.exists()) {
            res.status(400).json({ success: false, message: "User already exists" });
            return;
        }

        // 2. Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 3. Create user ref
        const newUserRef = rtdb.ref(USERS_PATH).push();
        const userId = newUserRef.key;

        const newUser = {
            name,
            email,
            password: hashedPassword,
            role: role || "sales_rep",
            isActive: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        await newUserRef.set(newUser);

        res.status(201).json({
            success: true,
            data: {
                _id: userId,
                name,
                email,
                role: newUser.role,
                token: generateToken(userId as string)
            }
        });
    } catch (error: any) {
        console.error("❌ CREATE USER ERROR:", error);
        res.status(400).json({ success: false, message: error.message });
    }
};

export const signInUser = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            res.status(400).json({ success: false, message: "Please provide email and password" });
            return;
        }

        // 1. Find user by email
        const snapshot = await rtdb.ref(USERS_PATH).orderByChild("email").equalTo(email).once("value");

        if (!snapshot.exists()) {
            res.status(401).json({ success: false, message: "Invalid credentials" });
            return;
        }

        // 2. Get user data
        const users = snapshot.val();
        const userId = Object.keys(users)[0] as string;
        const userData = users[userId];

        // 3. Compare password
        const isMatch = await bcrypt.compare(password, userData.password);

        if (isMatch) {
            res.status(200).json({
                success: true,
                data: {
                    _id: userId,
                    name: userData.name,
                    email: userData.email,
                    role: userData.role,
                    token: generateToken(userId)
                }
            });
        } else {
            res.status(401).json({ success: false, message: "Invalid credentials" });
        }
    } catch (error: any) {
        console.error("❌ SIGNIN ERROR:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export const deleteUser = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        if (!id) {
            res.status(400).json({ success: false, message: "User ID is required" });
            return;
        }

        await rtdb.ref(`${USERS_PATH}/${id}`).remove();
        
        res.status(200).json({
            success: true,
            message: "User deleted successfully"
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updateUser = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const { name, email, role, password } = req.body;

        if (!id) {
            res.status(400).json({ success: false, message: "User ID is required" });
            return;
        }

        const userRef = rtdb.ref(`${USERS_PATH}/${id}`);
        const snapshot = await userRef.once("value");

        if (!snapshot.exists()) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }

        const updateData: any = {
            updatedAt: Date.now()
        };

        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (role) {
            res.status(403).json({ success: false, message: "Role updates are only allowed from admin user management" });
            return;
        }
        if (password) {
            const salt = await bcrypt.genSalt(10);
            updateData.password = await bcrypt.hash(password, salt);
        }

        await userRef.update(updateData);

        res.status(200).json({
            success: true,
            message: "User updated successfully",
            data: {
                _id: id,
                ...updateData
            }
        });

    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};