#!/usr/bin/env python3
import json
import os
import sys

TODO_FILE = os.path.expanduser("~/levi/todos.json")

def load_todos():
    if os.path.exists(TODO_FILE):
        try:
            with open(TODO_FILE, "r") as f:
                return json.load(f)
        except Exception:
            return []
    return []

def save_todos(todos):
    os.makedirs(os.path.dirname(TODO_FILE), exist_ok=True)
    with open(TODO_FILE, "w") as f:
        json.dump(todos, f, indent=2)

def list_todos(todos):
    if not todos:
        print("\nNo todos found! Add one to get started.")
        return
    print("\n--- YOUR TODOS ---")
    for idx, todo in enumerate(todos, 1):
        status = "[x] " if todo["completed"] else "[ ] "
        print(f"{idx}. {status}{todo['task']}")
    print("-" * 18)

def add_todo(todos, task_text):
    if not task_text.strip():
        print("Task cannot be empty.")
        return
    todos.append({"task": task_text.strip(), "completed": False})
    save_todos(todos)
    print(f"Added: '{task_text.strip()}'")

def complete_todo(todos, index):
    if 0 <= index < len(todos):
        todos[index]["completed"] = True
        save_todos(todos)
        print(f"Completed: '{todos[index]['task']}'")
    else:
        print("Invalid task number.")

def delete_todo(todos, index):
    if 0 <= index < len(todos):
        removed = todos.pop(index)
        save_todos(todos)
        print(f"Deleted: '{removed['task']}'")
    else:
        print("Invalid task number.")

def main():
    todos = load_todos()
    
    if len(sys.argv) > 1:
        cmd = sys.argv[1].lower()
        if cmd == "add":
            add_todo(todos, " ".join(sys.argv[2:]))
        elif cmd == "list":
            list_todos(todos)
        elif cmd == "done":
            try:
                complete_todo(todos, int(sys.argv[2]) - 1)
            except (IndexError, ValueError):
                print("Usage: python todo.py done <number>")
        elif cmd == "del":
            try:
                delete_todo(todos, int(sys.argv[2]) - 1)
            except (IndexError, ValueError):
                print("Usage: python todo.py del <number>")
        else:
            print("Unknown command. Use add, list, done, or del.")
        return

    # Interactive loop
    while True:
        print("\nCommands: [l]ist | [a]dd | [d]one <num> | [rm] <num> | [q]uit")
        choice = input("> ").strip().lower()
        
        if choice in ("q", "quit", "exit"):
            break
        elif choice in ("l", "list"):
            list_todos(todos)
        elif choice.startswith("a "):
            add_todo(todos, choice[2:])
        elif choice == "a":
            t = input("Enter task: ")
            add_todo(todos, t)
        elif choice.startswith("d "):
            try:
                idx = int(choice.split()[1]) - 1
                complete_todo(todos, idx)
            except ValueError:
                print("Invalid number.")
        elif choice.startswith("rm "):
            try:
                idx = int(choice.split()[1]) - 1
                delete_todo(todos, idx)
            except ValueError:
                print("Invalid number.")
        else:
            print("Unknown command.")

if __name__ == "__main__":
    main()
